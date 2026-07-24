-- pgmq.list_queues() can return meta rows whose q_/a_ tables were dropped
-- (prod leftover: replicate_data). Skip missing relations instead of failing.

CREATE OR REPLACE FUNCTION "public"."cleanup_queue_messages"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  queue_name text;
  cutoff timestamptz := pg_catalog.now() - INTERVAL '2 days';
  batch_size integer := 10000;
  max_batches_total integer := 40;
  batches_used integer := 0;
  deleted_batch integer;
  deleted_archived_total bigint := 0;
  deleted_stuck_total bigint := 0;
  did_work boolean;
  archive_rel regclass;
  queue_rel regclass;
BEGIN
  LOOP
    EXIT WHEN batches_used >= max_batches_total;
    did_work := false;

    FOR queue_name IN (
      SELECT q.queue_name FROM pgmq.list_queues() q
    ) LOOP
      EXIT WHEN batches_used >= max_batches_total;

      archive_rel := to_regclass(pg_catalog.format('pgmq.a_%I', queue_name));
      queue_rel := to_regclass(pg_catalog.format('pgmq.q_%I', queue_name));

      IF archive_rel IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'DELETE FROM pgmq.a_%I
           WHERE ctid IN (
             SELECT ctid
             FROM pgmq.a_%I
             WHERE archived_at < $1
             LIMIT $2
           )',
          queue_name,
          queue_name
        )
        USING cutoff, batch_size;

        GET DIAGNOSTICS deleted_batch = ROW_COUNT;
        IF deleted_batch > 0 THEN
          batches_used := batches_used + 1;
          deleted_archived_total := deleted_archived_total + deleted_batch;
          did_work := true;
        END IF;
      END IF;

      IF batches_used >= max_batches_total THEN
        EXIT;
      END IF;

      IF queue_rel IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'DELETE FROM pgmq.q_%I
           WHERE ctid IN (
             SELECT ctid
             FROM pgmq.q_%I
             WHERE read_ct > 5
             LIMIT $1
           )',
          queue_name,
          queue_name
        )
        USING batch_size;

        GET DIAGNOSTICS deleted_batch = ROW_COUNT;
        IF deleted_batch > 0 THEN
          batches_used := batches_used + 1;
          deleted_stuck_total := deleted_stuck_total + deleted_batch;
          did_work := true;
        END IF;
      END IF;
    END LOOP;

    EXIT WHEN NOT did_work;
  END LOOP;

  RAISE NOTICE
    'cleanup_queue_messages: archived_deleted=% stuck_deleted=% batches_used=%/%',
    deleted_archived_total,
    deleted_stuck_total,
    batches_used,
    max_batches_total;
END;
$$;

ALTER FUNCTION "public"."cleanup_queue_messages"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."cleanup_queue_messages"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_queue_messages"() TO "service_role";

-- Drop obsolete meta row with no q_/a_ tables (documented as omitted in prod baseline).
-- Guard for environments without pgmq.meta (Tinbase/PGlite catalog builds).
DO $$
BEGIN
  IF to_regclass('pgmq.meta') IS NOT NULL THEN
    DELETE FROM pgmq.meta
    WHERE queue_name = 'replicate_data'
      AND to_regclass('pgmq.q_replicate_data') IS NULL
      AND to_regclass('pgmq.a_replicate_data') IS NULL;
  END IF;
END $$;
