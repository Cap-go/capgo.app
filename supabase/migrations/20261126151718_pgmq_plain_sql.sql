-- pgmq stops being an extension and stays as plain SQL objects.
--
-- Every member of the pgmq extension (functions, types, sequences, pgmq.meta,
-- and locally the queue tables too) is detached, then the now empty extension
-- is dropped. Nothing is copied and no data moves: the objects keep their
-- names, owners, grants and rows, and pgmq.send/read/archive/create/drop_queue
-- keep working because pgmq 1.5 skips its ALTER EXTENSION calls once
-- pgmq._extension_exists('pgmq') is false.
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
-- No-op where pgmq is not an installed extension (Tinbase emulates it in plain
-- SQL) or where it was already detached.
--
-- Not done here: one msg_id sequence on prod has no queue table left; it is
-- detached like the rest and kept.
DO $$
DECLARE
  member record;
  remaining text;
BEGIN
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
