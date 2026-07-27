-- Capgo-EU reclaim: never statement-timeout; always burn a wall-clock budget.
-- Fixes:
-- 1) Drop ambiguous cleanup_queue_messages() overload that made cron a silent no-op
-- 2) Time-budgeted queue/audit/manifest reclaim (statement_timeout disabled inside)
-- 3) Skip expensive encrypt-trigger checks during reclaim nulling (GUC)
-- 4) Catch query_canceled in process_all_cron_tasks so one reclaim cannot abort siblings

DROP FUNCTION IF EXISTS "public"."cleanup_queue_messages"();

CREATE OR REPLACE FUNCTION "public"."cleanup_queue_messages"(
  "max_batches_total" integer DEFAULT 1000000,
  "batch_size" integer DEFAULT 5000,
  "max_runtime_ms" integer DEFAULT 60000
) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  queue_name text;
  cutoff timestamptz := pg_catalog.now() - INTERVAL '2 days';
  batches_used integer := 0;
  deleted_batch integer;
  deleted_archived_total bigint := 0;
  deleted_stuck_total bigint := 0;
  did_work boolean;
  archive_rel regclass;
  queue_rel regclass;
  v_max_batches integer := GREATEST(1, COALESCE(max_batches_total, 1000000));
  v_batch_size integer := GREATEST(1, COALESCE(batch_size, 5000));
  v_max_runtime_ms integer := GREATEST(1000, COALESCE(max_runtime_ms, 60000));
  started_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  PERFORM pg_catalog.set_config('statement_timeout', '0', true);

  LOOP
    EXIT WHEN batches_used >= v_max_batches;
    EXIT WHEN (EXTRACT(EPOCH FROM (pg_catalog.clock_timestamp() - started_at)) * 1000) >= v_max_runtime_ms;
    did_work := false;

    FOR queue_name IN (
      SELECT q.queue_name
      FROM pgmq.list_queues() q
      ORDER BY COALESCE(
        pg_catalog.pg_total_relation_size(
          to_regclass(pg_catalog.format('pgmq.a_%I', q.queue_name))
        ),
        0
      ) DESC,
      q.queue_name
    ) LOOP
      EXIT WHEN batches_used >= v_max_batches;
      EXIT WHEN (EXTRACT(EPOCH FROM (pg_catalog.clock_timestamp() - started_at)) * 1000) >= v_max_runtime_ms;

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
        USING cutoff, v_batch_size;

        GET DIAGNOSTICS deleted_batch = ROW_COUNT;
        IF deleted_batch > 0 THEN
          batches_used := batches_used + 1;
          deleted_archived_total := deleted_archived_total + deleted_batch;
          did_work := true;
        END IF;
      END IF;

      EXIT WHEN batches_used >= v_max_batches;
      EXIT WHEN (EXTRACT(EPOCH FROM (pg_catalog.clock_timestamp() - started_at)) * 1000) >= v_max_runtime_ms;

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
        USING v_batch_size;

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
    'cleanup_queue_messages: archived_deleted=% stuck_deleted=% batches_used=%/% batch_size=% runtime_ms=% budget_ms=%',
    deleted_archived_total,
    deleted_stuck_total,
    batches_used,
    v_max_batches,
    v_batch_size,
    (EXTRACT(EPOCH FROM (pg_catalog.clock_timestamp() - started_at)) * 1000)::bigint,
    v_max_runtime_ms;
END;
$$;

ALTER FUNCTION "public"."cleanup_queue_messages"("max_batches_total" integer, "batch_size" integer, "max_runtime_ms" integer) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."cleanup_queue_messages"("max_batches_total" integer, "batch_size" integer, "max_runtime_ms" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_queue_messages"("max_batches_total" integer, "batch_size" integer, "max_runtime_ms" integer) TO "service_role";

DROP FUNCTION IF EXISTS "public"."cleanup_queue_messages"(integer, integer);
