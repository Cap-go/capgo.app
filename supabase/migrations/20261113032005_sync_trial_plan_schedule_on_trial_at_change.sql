-- When stripe_info.trial_at changes, enqueue sync_trial_plan_schedule so pending
-- trial-end subscription schedules move to the new trial end date.
SET LOCAL lock_timeout = '2s';

SELECT pgmq.create('sync_trial_plan_schedule');

CREATE OR REPLACE FUNCTION public.wake_sync_trial_plan_schedule(
  p_customer_id text,
  p_trial_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM pgmq.send(
    'sync_trial_plan_schedule',
    pg_catalog.jsonb_build_object(
      'function_name', 'sync_trial_plan_schedule',
      'function_type', 'cloudflare',
      'payload', pg_catalog.jsonb_build_object(
        'customerId', p_customer_id,
        'trialAt', pg_catalog.to_jsonb(p_trial_at)
      )
    )
  );
  PERFORM public.process_function_queue('sync_trial_plan_schedule', 1);
END;
$$;

ALTER FUNCTION public.wake_sync_trial_plan_schedule(text, timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wake_sync_trial_plan_schedule(text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wake_sync_trial_plan_schedule(text, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wake_sync_trial_plan_schedule(text, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.trigger_sync_trial_plan_schedule_on_trial_at_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.trial_at IS NOT DISTINCT FROM OLD.trial_at THEN
    RETURN NEW;
  END IF;

  PERFORM public.wake_sync_trial_plan_schedule(NEW.customer_id, NEW.trial_at);
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.trigger_sync_trial_plan_schedule_on_trial_at_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.trigger_sync_trial_plan_schedule_on_trial_at_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trigger_sync_trial_plan_schedule_on_trial_at_change() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_sync_trial_plan_schedule_on_trial_at_change() TO service_role;

DROP TRIGGER IF EXISTS sync_trial_plan_schedule_on_stripe_info_trial_at ON public.stripe_info;

CREATE TRIGGER sync_trial_plan_schedule_on_stripe_info_trial_at
AFTER UPDATE OF trial_at ON public.stripe_info
FOR EACH ROW
EXECUTE FUNCTION public.trigger_sync_trial_plan_schedule_on_trial_at_change();

COMMENT ON FUNCTION public.wake_sync_trial_plan_schedule(text, timestamptz) IS
'Internal: enqueue sync_trial_plan_schedule with the new trial end so Stripe trial plan schedules follow stripe_info.trial_at.';

DO $$
DECLARE
  high_frequency_task_type public.cron_task_type;
  high_frequency_target jsonb;
BEGIN
  SELECT cron.task_type, cron.target::jsonb
  INTO high_frequency_task_type, high_frequency_target
  FROM public.cron_tasks AS cron
  WHERE cron.name = 'high_frequency_queues'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Required cron task high_frequency_queues is missing';
  END IF;

  IF high_frequency_task_type
    IS DISTINCT FROM 'function_queue'::public.cron_task_type THEN
    RAISE EXCEPTION 'Cron task high_frequency_queues must use task type function_queue';
  END IF;

  IF pg_catalog.jsonb_typeof(high_frequency_target)
    IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Cron task high_frequency_queues target must be a JSON array';
  END IF;

  IF NOT (high_frequency_target ? 'sync_trial_plan_schedule') THEN
    UPDATE public.cron_tasks
    SET
      target = (high_frequency_target || '["sync_trial_plan_schedule"]'::jsonb)::text,
      updated_at = pg_catalog.now()
    WHERE name = 'high_frequency_queues';
  END IF;
END;
$$;
