-- pgmq stops being an extension and stays as plain SQL objects.
--
-- Every member of the pgmq extension (functions, types, sequences, pgmq.meta,
-- and locally the queue tables too) is detached, then the now empty extension
-- is dropped. Nothing is copied and no data moves: the objects keep their
-- names, owners, grants and rows.
--
-- Prod's pgmq 1.5.1 bodies of five functions run ALTER EXTENSION pgmq ... with
-- no check that the extension exists, so without it pgmq.create and
-- pgmq.drop_queue would fail ("extension "pgmq" does not exist"). Before
-- detaching, they are replaced with prod's exact bodies where each
-- ALTER EXTENSION step only runs when pgmq is an installed extension
-- (pgmq._extension_exists('pgmq')), the check newer pgmq releases use. Nothing
-- else in them changes; tests/fixtures/pgmq-prod-1.5.1-old-functions.sql holds
-- prod's originals. CREATE OR REPLACE keeps each function's owner and grants
-- (drop_queue stays owned by supabase_admin; postgres is a member of it).
-- Locally this also replaces the image's newer bodies with prod's, so local and
-- prod run the same code.
--
-- Why: a schema dump then carries pgmq as plain functions and tables, so the
-- database no longer needs the pgmq extension to be installable. It also
-- removes the drift where local queue tables are extension members and prod
-- ones are not (see 20261017142629_remove_admin_stats_generation).
--
-- Order matters: relations are detached first, so pgmq.meta leaves the
-- extension as a table. Detaching its row type first would leave the table a
-- member, and DROP EXTENSION would then delete pgmq.meta with its rows. Array
-- types and table row types are skipped: they follow their element type or
-- table.
--
-- No error is swallowed: a member that cannot be detached (for example a
-- function owned by a role the migration user cannot act as) fails the
-- migration with Postgres' own error. The guard after the loop makes sure
-- DROP EXTENSION never runs while anything is still a member.
--
-- No-op where pgmq is not an installed extension: Tinbase emulates pgmq in
-- plain SQL with its own drop_queue, which must not be replaced, and a database
-- where this already ran has nothing left to do.
--
-- Not done here: one msg_id sequence on prod has no queue table left; it is
-- detached like the rest and kept.
DO $$
DECLARE
  member record;
  remaining text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pgmq') THEN
    RETURN;
  END IF;

  EXECUTE $fn$
CREATE OR REPLACE FUNCTION pgmq.create_non_partitioned(queue_name text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  qtable TEXT := pgmq.format_table_name(queue_name, 'q');
  qtable_seq TEXT := qtable || '_msg_id_seq';
  atable TEXT := pgmq.format_table_name(queue_name, 'a');
BEGIN
  PERFORM pgmq.validate_queue_name(queue_name);

  EXECUTE FORMAT(
    $QUERY$
    CREATE TABLE IF NOT EXISTS pgmq.%I (
        msg_id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        read_ct INT DEFAULT 0 NOT NULL,
        enqueued_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        vt TIMESTAMP WITH TIME ZONE NOT NULL,
        message JSONB,
        headers JSONB
    )
    $QUERY$,
    qtable
  );

  EXECUTE FORMAT(
    $QUERY$
    CREATE TABLE IF NOT EXISTS pgmq.%I (
      msg_id BIGINT PRIMARY KEY,
      read_ct INT DEFAULT 0 NOT NULL,
      enqueued_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
      archived_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
      vt TIMESTAMP WITH TIME ZONE NOT NULL,
      message JSONB,
      headers JSONB
    );
    $QUERY$,
    atable
  );

  IF pgmq._extension_exists('pgmq') AND NOT pgmq._belongs_to_pgmq(qtable) THEN
      EXECUTE FORMAT('ALTER EXTENSION pgmq ADD TABLE pgmq.%I', qtable);
      EXECUTE FORMAT('ALTER EXTENSION pgmq ADD SEQUENCE pgmq.%I', qtable_seq);
  END IF;

  IF pgmq._extension_exists('pgmq') AND NOT pgmq._belongs_to_pgmq(atable) THEN
      EXECUTE FORMAT('ALTER EXTENSION pgmq ADD TABLE pgmq.%I', atable);
  END IF;

  EXECUTE FORMAT(
    $QUERY$
    CREATE INDEX IF NOT EXISTS %I ON pgmq.%I (vt ASC);
    $QUERY$,
    qtable || '_vt_idx', qtable
  );

  EXECUTE FORMAT(
    $QUERY$
    CREATE INDEX IF NOT EXISTS %I ON pgmq.%I (archived_at);
    $QUERY$,
    'archived_at_idx_' || queue_name, atable
  );

  EXECUTE FORMAT(
    $QUERY$
    INSERT INTO pgmq.meta (queue_name, is_partitioned, is_unlogged)
    VALUES (%L, false, false)
    ON CONFLICT
    DO NOTHING;
    $QUERY$,
    queue_name
  );
END;
$function$
$fn$;

  EXECUTE $fn$
CREATE OR REPLACE FUNCTION pgmq.create_partitioned(queue_name text, partition_interval text DEFAULT '10000'::text, retention_interval text DEFAULT '100000'::text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  partition_col TEXT;
  a_partition_col TEXT;
  qtable TEXT := pgmq.format_table_name(queue_name, 'q');
  qtable_seq TEXT := qtable || '_msg_id_seq';
  atable TEXT := pgmq.format_table_name(queue_name, 'a');
  fq_qtable TEXT := 'pgmq.' || qtable;
  fq_atable TEXT := 'pgmq.' || atable;
BEGIN
  PERFORM pgmq.validate_queue_name(queue_name);
  PERFORM pgmq._ensure_pg_partman_installed();
  SELECT pgmq._get_partition_col(partition_interval) INTO partition_col;

  EXECUTE FORMAT(
    $QUERY$
    CREATE TABLE IF NOT EXISTS pgmq.%I (
        msg_id BIGINT GENERATED ALWAYS AS IDENTITY,
        read_ct INT DEFAULT 0 NOT NULL,
        enqueued_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        vt TIMESTAMP WITH TIME ZONE NOT NULL,
        message JSONB,
        headers JSONB
    ) PARTITION BY RANGE (%I)
    $QUERY$,
    qtable, partition_col
  );

  IF pgmq._extension_exists('pgmq') AND NOT pgmq._belongs_to_pgmq(qtable) THEN
      EXECUTE FORMAT('ALTER EXTENSION pgmq ADD TABLE pgmq.%I', qtable);
      EXECUTE FORMAT('ALTER EXTENSION pgmq ADD SEQUENCE pgmq.%I', qtable_seq);
  END IF;

  -- https://github.com/pgpartman/pg_partman/blob/master/doc/pg_partman.md
  -- p_parent_table - the existing parent table. MUST be schema qualified, even if in public schema.
  EXECUTE FORMAT(
    $QUERY$
    SELECT %I.create_parent(
      p_parent_table := %L,
      p_control := %L,
      p_interval := %L,
      p_type := case
        when pgmq._get_pg_partman_major_version() = 5 then 'range'
        else 'native'
      end
    )
    $QUERY$,
    pgmq._get_pg_partman_schema(),
    fq_qtable,
    partition_col,
    partition_interval
  );

  EXECUTE FORMAT(
    $QUERY$
    CREATE INDEX IF NOT EXISTS %I ON pgmq.%I (%I);
    $QUERY$,
    qtable || '_part_idx', qtable, partition_col
  );

  EXECUTE FORMAT(
    $QUERY$
    UPDATE %I.part_config
    SET
        retention = %L,
        retention_keep_table = false,
        retention_keep_index = true,
        automatic_maintenance = 'on'
    WHERE parent_table = %L;
    $QUERY$,
    pgmq._get_pg_partman_schema(),
    retention_interval,
    'pgmq.' || qtable
  );

  EXECUTE FORMAT(
    $QUERY$
    INSERT INTO pgmq.meta (queue_name, is_partitioned, is_unlogged)
    VALUES (%L, true, false)
    ON CONFLICT
    DO NOTHING;
    $QUERY$,
    queue_name
  );

  IF partition_col = 'enqueued_at' THEN
    a_partition_col := 'archived_at';
  ELSE
    a_partition_col := partition_col;
  END IF;

  EXECUTE FORMAT(
    $QUERY$
    CREATE TABLE IF NOT EXISTS pgmq.%I (
      msg_id BIGINT NOT NULL,
      read_ct INT DEFAULT 0 NOT NULL,
      enqueued_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
      archived_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
      vt TIMESTAMP WITH TIME ZONE NOT NULL,
      message JSONB,
      headers JSONB
    ) PARTITION BY RANGE (%I);
    $QUERY$,
    atable, a_partition_col
  );

  IF pgmq._extension_exists('pgmq') AND NOT pgmq._belongs_to_pgmq(atable) THEN
      EXECUTE FORMAT('ALTER EXTENSION pgmq ADD TABLE pgmq.%I', atable);
  END IF;

  -- https://github.com/pgpartman/pg_partman/blob/master/doc/pg_partman.md
  -- p_parent_table - the existing parent table. MUST be schema qualified, even if in public schema.
  EXECUTE FORMAT(
    $QUERY$
    SELECT %I.create_parent(
      p_parent_table := %L,
      p_control := %L,
      p_interval := %L,
      p_type := case
        when pgmq._get_pg_partman_major_version() = 5 then 'range'
        else 'native'
      end
    )
    $QUERY$,
    pgmq._get_pg_partman_schema(),
    fq_atable,
    a_partition_col,
    partition_interval
  );

  EXECUTE FORMAT(
    $QUERY$
    UPDATE %I.part_config
    SET
        retention = %L,
        retention_keep_table = false,
        retention_keep_index = true,
        automatic_maintenance = 'on'
    WHERE parent_table = %L;
    $QUERY$,
    pgmq._get_pg_partman_schema(),
    retention_interval,
    'pgmq.' || atable
  );

  EXECUTE FORMAT(
    $QUERY$
    CREATE INDEX IF NOT EXISTS %I ON pgmq.%I (archived_at);
    $QUERY$,
    'archived_at_idx_' || queue_name, atable
  );

END;
$function$
$fn$;

  EXECUTE $fn$
CREATE OR REPLACE FUNCTION pgmq.create_unlogged(queue_name text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  qtable TEXT := pgmq.format_table_name(queue_name, 'q');
  qtable_seq TEXT := qtable || '_msg_id_seq';
  atable TEXT := pgmq.format_table_name(queue_name, 'a');
BEGIN
  PERFORM pgmq.validate_queue_name(queue_name);
  EXECUTE FORMAT(
    $QUERY$
    CREATE UNLOGGED TABLE IF NOT EXISTS pgmq.%I (
        msg_id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        read_ct INT DEFAULT 0 NOT NULL,
        enqueued_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        vt TIMESTAMP WITH TIME ZONE NOT NULL,
        message JSONB,
        headers JSONB
    )
    $QUERY$,
    qtable
  );

  EXECUTE FORMAT(
    $QUERY$
    CREATE TABLE IF NOT EXISTS pgmq.%I (
      msg_id BIGINT PRIMARY KEY,
      read_ct INT DEFAULT 0 NOT NULL,
      enqueued_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
      archived_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
      vt TIMESTAMP WITH TIME ZONE NOT NULL,
      message JSONB,
      headers JSONB
    );
    $QUERY$,
    atable
  );

  IF pgmq._extension_exists('pgmq') AND NOT pgmq._belongs_to_pgmq(qtable) THEN
      EXECUTE FORMAT('ALTER EXTENSION pgmq ADD TABLE pgmq.%I', qtable);
      EXECUTE FORMAT('ALTER EXTENSION pgmq ADD SEQUENCE pgmq.%I', qtable_seq);
  END IF;

  IF pgmq._extension_exists('pgmq') AND NOT pgmq._belongs_to_pgmq(atable) THEN
      EXECUTE FORMAT('ALTER EXTENSION pgmq ADD TABLE pgmq.%I', atable);
  END IF;

  EXECUTE FORMAT(
    $QUERY$
    CREATE INDEX IF NOT EXISTS %I ON pgmq.%I (vt ASC);
    $QUERY$,
    qtable || '_vt_idx', qtable
  );

  EXECUTE FORMAT(
    $QUERY$
    CREATE INDEX IF NOT EXISTS %I ON pgmq.%I (archived_at);
    $QUERY$,
    'archived_at_idx_' || queue_name, atable
  );

  EXECUTE FORMAT(
    $QUERY$
    INSERT INTO pgmq.meta (queue_name, is_partitioned, is_unlogged)
    VALUES (%L, false, true)
    ON CONFLICT
    DO NOTHING;
    $QUERY$,
    queue_name
  );
END;
$function$
$fn$;

  EXECUTE $fn$
CREATE OR REPLACE FUNCTION pgmq.detach_archive(queue_name text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  atable TEXT := pgmq.format_table_name(queue_name, 'a');
BEGIN
  IF pgmq._extension_exists('pgmq') THEN
    EXECUTE format('ALTER EXTENSION pgmq DROP TABLE pgmq.%I', atable);
  END IF;
END
$function$
$fn$;

  EXECUTE $fn$
CREATE OR REPLACE FUNCTION pgmq.drop_queue(queue_name text)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
    qtable TEXT := pgmq.format_table_name(queue_name, 'q');
    qtable_seq TEXT := qtable || '_msg_id_seq';
    fq_qtable TEXT := 'pgmq.' || qtable;
    atable TEXT := pgmq.format_table_name(queue_name, 'a');
    fq_atable TEXT := 'pgmq.' || atable;
    partitioned BOOLEAN;
BEGIN
    EXECUTE FORMAT(
        $QUERY$
        SELECT is_partitioned FROM pgmq.meta WHERE queue_name = %L
        $QUERY$,
        queue_name
    ) INTO partitioned;

    IF pgmq._extension_exists('pgmq') THEN
        EXECUTE FORMAT(
            $QUERY$
            ALTER EXTENSION pgmq DROP TABLE pgmq.%I
            $QUERY$,
            qtable
        );

        EXECUTE FORMAT(
            $QUERY$
            ALTER EXTENSION pgmq DROP SEQUENCE pgmq.%I
            $QUERY$,
            qtable_seq
        );

        EXECUTE FORMAT(
            $QUERY$
            ALTER EXTENSION pgmq DROP TABLE pgmq.%I
            $QUERY$,
            atable
        );
    END IF;

    EXECUTE FORMAT(
        $QUERY$
        DROP TABLE IF EXISTS pgmq.%I
        $QUERY$,
        qtable
    );

    EXECUTE FORMAT(
        $QUERY$
        DROP TABLE IF EXISTS pgmq.%I
        $QUERY$,
        atable
    );

     IF EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_name = 'meta' and table_schema = 'pgmq'
     ) THEN
        EXECUTE FORMAT(
            $QUERY$
            DELETE FROM pgmq.meta WHERE queue_name = %L
            $QUERY$,
            queue_name
        );
     END IF;

     IF partitioned THEN
        EXECUTE FORMAT(
          $QUERY$
          DELETE FROM %I.part_config where parent_table in (%L, %L)
          $QUERY$,
          pgmq._get_pg_partman_schema(), fq_qtable, fq_atable
        );
     END IF;

    RETURN TRUE;
END;
$function$
$fn$;

  FOR member IN
    SELECT (pg_identify_object(d.classid, d.objid, 0)).type AS object_type,
           (pg_identify_object(d.classid, d.objid, 0)).identity AS object_identity
    FROM pg_catalog.pg_depend AS d
    JOIN pg_catalog.pg_extension AS e ON e.oid = d.refobjid
    WHERE d.refclassid = 'pg_catalog.pg_extension'::regclass
      AND d.deptype = 'e'
      AND e.extname = 'pgmq'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_type AS ty
        WHERE d.classid = 'pg_catalog.pg_type'::regclass
          AND ty.oid = d.objid
          AND (
            ty.typcategory = 'A'
            OR EXISTS (
              SELECT 1 FROM pg_catalog.pg_class AS c
              WHERE c.oid = ty.typrelid AND c.relkind <> 'c'
            )
          )
      )
    ORDER BY (d.classid = 'pg_catalog.pg_class'::regclass) DESC, 1, 2
  LOOP
    EXECUTE format('ALTER EXTENSION pgmq DROP %s %s', member.object_type, member.object_identity);
  END LOOP;

  SELECT string_agg(pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid), ', ')
  INTO remaining
  FROM pg_catalog.pg_depend AS d
  JOIN pg_catalog.pg_extension AS e ON e.oid = d.refobjid
  WHERE d.refclassid = 'pg_catalog.pg_extension'::regclass
    AND d.deptype = 'e'
    AND e.extname = 'pgmq';

  IF remaining IS NOT NULL THEN
    RAISE EXCEPTION 'pgmq still has extension members, not dropping it: %', remaining;
  END IF;
END;
$$;

-- No CASCADE: the extension is empty now, and if anything still depends on it
-- this fails instead of dropping it.
DROP EXTENSION IF EXISTS pgmq;
