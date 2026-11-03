-- When stripe_info.trial_at changes, wake sync_trial_plan_schedule so pending
-- trial-end subscription schedules move to the new trial end date.
SET LOCAL lock_timeout = '2s';

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
  PERFORM public.http_dispatch_post(
    p_target := 'sync_trial_plan_schedule',
    p_url := public.get_db_url() || '/functions/v1/triggers/sync_trial_plan_schedule',
    p_headers := pg_catalog.jsonb_build_object(
      'Content-Type', 'application/json',
      'apisecret', public.get_apikey()
    ),
    p_body := pg_catalog.jsonb_build_object(
      'customerId', p_customer_id,
      'trialAt', pg_catalog.to_jsonb(p_trial_at)
    ),
    p_timeout_ms := 30000,
    p_calls := 1
  );
END;
$$;

ALTER FUNCTION public.wake_sync_trial_plan_schedule(text, timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wake_sync_trial_plan_schedule(text, timestamptz) FROM PUBLIC;
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
GRANT EXECUTE ON FUNCTION public.trigger_sync_trial_plan_schedule_on_trial_at_change() TO service_role;

DROP TRIGGER IF EXISTS sync_trial_plan_schedule_on_stripe_info_trial_at ON public.stripe_info;

CREATE TRIGGER sync_trial_plan_schedule_on_stripe_info_trial_at
AFTER UPDATE OF trial_at ON public.stripe_info
FOR EACH ROW
EXECUTE FUNCTION public.trigger_sync_trial_plan_schedule_on_trial_at_change();

COMMENT ON FUNCTION public.wake_sync_trial_plan_schedule(text, timestamptz) IS
'Internal: POST sync_trial_plan_schedule with the new trial end so Stripe trial plan schedules follow stripe_info.trial_at.';
