-- Align all queue retry budgets to 5, raise org-stats drain rate, and purge
-- already-stuck messages (read_ct > 5) so /queue_health can return healthy.

-- 1) org_stats_queue was batch 10 / every 5 minutes (~100 msgs/5m) and could not
-- keep up. Run every process_all_cron_tasks tick with a larger batch.
UPDATE public.cron_tasks
SET
  batch_size = 100,
  second_interval = 10,
  minute_interval = NULL,
  hour_interval = NULL,
  run_at_hour = NULL,
  updated_at = now()
WHERE name = 'org_stats_queue';

-- 2) Webhook delivery application retries must also obey the global max of 5.
ALTER TABLE public.webhook_deliveries
  ALTER COLUMN max_attempts SET DEFAULT 5;

UPDATE public.webhook_deliveries
SET max_attempts = 5
WHERE max_attempts > 5;

-- 3) Immediate purge of poison messages that already exceeded the hard retry
-- budget. Bounded per queue so deploy stays safe at production scale.
DO $$
DECLARE
  queue_name text;
  deleted_batch integer;
  deleted_total bigint := 0;
  batch_size integer := 5000;
  max_batches_per_queue integer := 20;
  batches_used integer;
BEGIN
  IF to_regclass('pgmq.meta') IS NULL THEN
    RAISE NOTICE 'queue_health_retry_budget_5: pgmq.meta missing, skip stuck purge';
    RETURN;
  END IF;

  FOR queue_name IN
    SELECT q.queue_name
    FROM pgmq.list_queues() q
    ORDER BY q.queue_name
  LOOP
    IF to_regclass(format('pgmq.q_%I', queue_name)) IS NULL THEN
      CONTINUE;
    END IF;

    batches_used := 0;
    LOOP
      EXIT WHEN batches_used >= max_batches_per_queue;

      EXECUTE format(
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
      EXIT WHEN deleted_batch = 0;

      batches_used := batches_used + 1;
      deleted_total := deleted_total + deleted_batch;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'queue_health_retry_budget_5: deleted_stuck_read_ct=%', deleted_total;
END;
$$;
