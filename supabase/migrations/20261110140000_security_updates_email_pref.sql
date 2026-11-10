-- Opt-in email preference for Capacitor security update notifications (users only, default false).

UPDATE public.users
SET email_preferences = email_preferences || '{"security_updates": false}'::jsonb
WHERE email_preferences IS NOT NULL
  AND NOT (email_preferences ? 'security_updates');

ALTER TABLE public.users
ALTER COLUMN email_preferences SET DEFAULT '{"onboarding": true, "usage_limit": true, "credit_usage": true, "device_error": true, "weekly_stats": true, "monthly_stats": true, "bundle_created": true, "bundle_deployed": true, "deploy_stats_24h": true, "cli_realtime_feed": true, "builder_onboarding": true, "bundle_incompatible": true, "billing_period_stats": true, "channel_self_rejected": true, "security_updates": false}'::jsonb;

COMMENT ON COLUMN public.users.email_preferences IS 'Per-user email notification preferences. Keys: usage_limit, credit_usage, onboarding, builder_onboarding, weekly_stats, monthly_stats, billing_period_stats, deploy_stats_24h, bundle_created, bundle_deployed, device_error, channel_self_rejected, cli_realtime_feed, bundle_incompatible, security_updates. Values are booleans. security_updates defaults false (opt-in).';
