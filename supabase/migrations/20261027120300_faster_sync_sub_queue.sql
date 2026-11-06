-- per_minute_queues kept batch_size 10 only so cron_stat_app stayed under the
-- Cloudflare API limit. cron_stat_app now has its own stat_app_queue task, so
-- the small batch only throttled cron_sync_sub to 100 orgs/min and the daily
-- ~8,000-org sync took about 90 minutes.
-- The consumer processes each call in the background, 25 messages at a time,
-- with a 15s per-message timeout and a 120s visibility timeout, so a batch of
-- 100 finishes in at most 4 rounds (60s). Ten calls per minute drain up to
-- 1,000 orgs/min.
UPDATE public.cron_tasks
SET
    batch_size = 100,
    description = 'Consume up to 10 batches of 100 cron_sync_sub messages per minute',
    updated_at = pg_catalog.now()
WHERE name = 'per_minute_queues'
  AND task_type = 'function_queue';

CREATE OR REPLACE FUNCTION "public"."process_cron_sync_sub_jobs"()
RETURNS void
LANGUAGE plpgsql
SET search_path TO ''
AS $$
DECLARE
  org_record RECORD;
  -- per_minute_queues drains up to 1,000/min; release 500/min so the daily
  -- sync finishes in ~16 minutes with 2x headroom for slow Stripe calls.
  v_per_minute CONSTANT integer := 500;
  v_index integer := 0;
BEGIN
  FOR org_record IN
    SELECT DISTINCT
      o.id,
      si.customer_id
    FROM public.orgs AS o
    INNER JOIN public.stripe_info AS si ON o.customer_id = si.customer_id
    WHERE o.customer_id IS NOT NULL
      AND si.customer_id IS NOT NULL
  LOOP
    PERFORM pgmq.send(
      'cron_sync_sub',
      pg_catalog.jsonb_build_object(
        'function_name', 'cron_sync_sub',
        'function_type', NULL,
        'payload', pg_catalog.jsonb_build_object(
          'orgId', org_record.id,
          'customerId', org_record.customer_id
        )
      ),
      (v_index / v_per_minute) * 60
    );
    v_index := v_index + 1;
  END LOOP;
END;
$$;
