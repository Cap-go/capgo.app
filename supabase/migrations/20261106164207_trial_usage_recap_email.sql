-- Trial usage recap (day -3) and trial end usage summary emails, queued for Cloudflare cron_email worker.

CREATE OR REPLACE FUNCTION public.process_trial_usage_recap_email()
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  org_record RECORD;
  v_trial_date date;
  v_today date;
  v_zero_trial interval;
BEGIN
  v_today := (now() AT TIME ZONE 'UTC')::date;

  FOR org_record IN
    SELECT
      o.id AS org_id,
      o.management_email,
      o.created_at AS org_created_at,
      si.trial_at AS trial_at_ts
    FROM public.orgs o
    INNER JOIN public.stripe_info si ON o.customer_id = si.customer_id
    WHERE o.management_email IS NOT NULL
      AND si.trial_at IS NOT NULL
      AND (si.trial_at AT TIME ZONE 'UTC')::date > v_today
      AND (si.status IS NULL OR si.status IS DISTINCT FROM 'succeeded'::public.stripe_status)
  LOOP
    v_trial_date := (org_record.trial_at_ts AT TIME ZONE 'UTC')::date;
    v_zero_trial := org_record.trial_at_ts - org_record.org_created_at;
    -- Paid ads and similar: skip when there is no real multi day trial window.
    IF v_zero_trial < interval '23 hours' THEN
      CONTINUE;
    END IF;

    IF v_today = v_trial_date - 3 THEN
      PERFORM pgmq.send(
        'cron_email',
        jsonb_build_object(
          'function_name', 'cron_email',
          'function_type', 'cloudflare',
          'payload', jsonb_build_object(
            'email', org_record.management_email,
            'orgId', org_record.org_id,
            'type', 'trial_usage_recap',
            'trialEndDate', v_trial_date::text
          )
        )
      );
    END IF;

    IF v_today = v_trial_date - 1 THEN
      PERFORM pgmq.send(
        'cron_email',
        jsonb_build_object(
          'function_name', 'cron_email',
          'function_type', 'cloudflare',
          'payload', jsonb_build_object(
            'email', org_record.management_email,
            'orgId', org_record.org_id,
            'type', 'trial_end_usage_recap',
            'trialEndDate', v_trial_date::text
          )
        )
      );
    END IF;
  END LOOP;
END;
$$;

ALTER FUNCTION public.process_trial_usage_recap_email() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.process_trial_usage_recap_email() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_trial_usage_recap_email() FROM anon;
REVOKE ALL ON FUNCTION public.process_trial_usage_recap_email() FROM authenticated;
GRANT ALL ON FUNCTION public.process_trial_usage_recap_email() TO service_role;

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
  enabled
) VALUES (
  'trial_usage_recap_email',
  'Queue trial usage recap (3 days before) and trial end summary emails',
  'function',
  'public.process_trial_usage_recap_email()',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  9,
  0,
  0,
  NULL,
  NULL,
  true
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

-- Default email preference for new orgs (trial recap uses the trial_usage_recap key).
ALTER TABLE public.orgs
  ALTER COLUMN email_preferences SET DEFAULT '{"onboarding": true, "usage_limit": true, "credit_usage": true, "device_error": true, "weekly_stats": true, "monthly_stats": true, "bundle_created": true, "bundle_deployed": true, "deploy_stats_24h": true, "trial_usage_recap": true, "billing_period_stats": true, "channel_self_rejected": true}'::jsonb;

COMMENT ON COLUMN public.orgs.email_preferences IS 'JSONB object containing email notification preferences for the organization. When enabled, emails are also sent to the management_email if it differs from admin user emails. Keys: usage_limit, credit_usage, onboarding, trial_usage_recap, weekly_stats, monthly_stats, billing_period_stats, deploy_stats_24h, bundle_created, bundle_deployed, device_error, channel_self_rejected. All default to true.';
