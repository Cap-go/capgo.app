-- Oct 27 raised the daily cron_sync_sub release rate to 500 orgs/min so Stripe
-- reads spiked during the 04:00 UTC burst and transient API failures were
-- misread as canceled subscriptions. Throttle the release to 120 orgs/min (~67
-- minutes for ~8,000 orgs) and cap the per-minute consumer at 250 orgs/min so
-- the queue stays ahead of Stripe without hammering it.

UPDATE public.cron_tasks
SET
    batch_size = 50,
    description = 'Consume up to 5 batches of 50 cron_sync_sub messages per minute',
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
  -- per_minute_queues drains up to 250/min; release 120/min to limit Stripe API load.
  v_per_minute CONSTANT integer := 120;
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
