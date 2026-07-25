-- Re-register billing period stats email after it was dropped from the cron path.
-- Original feature (#1335) called process_billing_period_stats_email() from
-- process_all_cron_tasks at 12:00 UTC. The cron_tasks table refactor never added
-- a row for it, so org:billing_period_stats was never queued.

CREATE OR REPLACE FUNCTION public.get_org_credits_used_in_period(
  p_org_id uuid,
  p_start timestamptz,
  p_end timestamptz
)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(SUM(c.credits_used), 0)::numeric
  FROM public.usage_credit_consumptions c
  WHERE c.org_id = p_org_id
    AND c.applied_at >= p_start
    AND c.applied_at < p_end;
$$;

ALTER FUNCTION public.get_org_credits_used_in_period(uuid, timestamptz, timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_org_credits_used_in_period(uuid, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_org_credits_used_in_period(uuid, timestamptz, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.get_org_credits_used_in_period(uuid, timestamptz, timestamptz) FROM authenticated;
GRANT ALL ON FUNCTION public.get_org_credits_used_in_period(uuid, timestamptz, timestamptz) TO service_role;

-- Stripe-style day-of-month clamping for billing anniversary detection.
-- Returns the completed cycle ending on p_as_of when that day is the
-- (clamped) anniversary; otherwise is_anniversary is false.
CREATE OR REPLACE FUNCTION public.billing_period_completed_cycle(
  p_anchor_start timestamptz,
  p_as_of date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  is_anniversary boolean,
  cycle_start timestamptz,
  cycle_end timestamptz
)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_anchor_dom integer;
  v_this_month_last integer;
  v_prev_month_last integer;
  v_this_anniv_dom integer;
  v_prev_anniv_dom integer;
BEGIN
  v_anchor_dom := COALESCE(EXTRACT(DAY FROM p_anchor_start)::integer, 1);
  v_this_month_last := EXTRACT(
    DAY FROM (date_trunc('month', p_as_of) + interval '1 month - 1 day')
  )::integer;
  v_prev_month_last := EXTRACT(
    DAY FROM (date_trunc('month', p_as_of) - interval '1 day')
  )::integer;
  v_this_anniv_dom := LEAST(v_anchor_dom, v_this_month_last);
  v_prev_anniv_dom := LEAST(v_anchor_dom, v_prev_month_last);

  is_anniversary := EXTRACT(DAY FROM p_as_of)::integer = v_this_anniv_dom;
  IF is_anniversary THEN
    cycle_start := date_trunc('month', p_as_of - interval '1 month')
      + ((v_prev_anniv_dom - 1) || ' days')::interval;
    cycle_end := date_trunc('month', p_as_of)
      + ((v_this_anniv_dom - 1) || ' days')::interval;
  ELSE
    cycle_start := NULL;
    cycle_end := NULL;
  END IF;

  RETURN NEXT;
END;
$$;

ALTER FUNCTION public.billing_period_completed_cycle(timestamptz, date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.billing_period_completed_cycle(timestamptz, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_period_completed_cycle(timestamptz, date) FROM anon;
REVOKE ALL ON FUNCTION public.billing_period_completed_cycle(timestamptz, date) FROM authenticated;
GRANT ALL ON FUNCTION public.billing_period_completed_cycle(timestamptz, date) TO service_role;

CREATE OR REPLACE FUNCTION public.process_billing_period_stats_email()
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  org_record RECORD;
  v_cycle RECORD;
BEGIN
  FOR org_record IN (
    SELECT
      o.id AS org_id,
      o.management_email,
      si.subscription_anchor_start
    FROM public.orgs o
    JOIN public.stripe_info si ON o.customer_id = si.customer_id
    WHERE si.status = 'succeeded'
      AND o.management_email IS NOT NULL
  )
  LOOP
    SELECT *
    INTO v_cycle
    FROM public.billing_period_completed_cycle(
      org_record.subscription_anchor_start,
      CURRENT_DATE
    );

    IF v_cycle.is_anniversary THEN
      PERFORM pgmq.send(
        'cron_email',
        jsonb_build_object(
          'function_name', 'cron_email',
          'function_type', 'cloudflare',
          'payload', jsonb_build_object(
            'email', org_record.management_email,
            'orgId', org_record.org_id,
            'type', 'billing_period_stats',
            'cycleStart', v_cycle.cycle_start,
            'cycleEnd', v_cycle.cycle_end
          )
        )
      );
    END IF;
  END LOOP;
END;
$$;

ALTER FUNCTION public.process_billing_period_stats_email() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.process_billing_period_stats_email() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_billing_period_stats_email() FROM anon;
REVOKE ALL ON FUNCTION public.process_billing_period_stats_email() FROM authenticated;
GRANT ALL ON FUNCTION public.process_billing_period_stats_email() TO service_role;

INSERT INTO public.cron_tasks (
  name,
  description,
  task_type,
  target,
  batch_size,
  payload,
  second_interval,
  minute_interval,
  hour_interval,
  run_at_hour,
  run_at_minute,
  run_at_second,
  run_on_dow,
  run_on_day,
  enabled,
  healthcheck_url
) VALUES (
  'billing_period_stats_email',
  'Send billing period stats emails on each org billing anniversary (12:00 UTC)',
  'function',
  'public.process_billing_period_stats_email()',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  12,
  0,
  0,
  NULL,
  NULL,
  true,
  NULL
)
ON CONFLICT (name) DO UPDATE
SET
  description = EXCLUDED.description,
  task_type = EXCLUDED.task_type,
  target = EXCLUDED.target,
  run_at_hour = EXCLUDED.run_at_hour,
  run_at_minute = EXCLUDED.run_at_minute,
  run_at_second = EXCLUDED.run_at_second,
  enabled = EXCLUDED.enabled,
  updated_at = now();
