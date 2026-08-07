ALTER TABLE public.global_stats
  ADD COLUMN IF NOT EXISTS notifications_apps bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notifications_providers bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notifications_campaigns bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notifications_campaigns_day bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notifications_sent_day bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notifications_received_day bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notifications_opened_day bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notifications_failed_day bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notifications_sent_last_month bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notifications_opened_last_month bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.global_stats.notifications_apps
  IS 'Distinct apps with at least one configured native push notification provider at snapshot time.';

COMMENT ON COLUMN public.global_stats.notifications_providers
  IS 'Count of configured native push notification provider configs at snapshot time.';

COMMENT ON COLUMN public.global_stats.notifications_campaigns
  IS 'Total native notification campaigns created up to snapshot day end.';

COMMENT ON COLUMN public.global_stats.notifications_campaigns_day
  IS 'Native notification campaigns created during the UTC snapshot day.';

COMMENT ON COLUMN public.global_stats.notifications_sent_day
  IS 'Native notification sent events during the UTC snapshot day (Cloudflare Analytics Engine).';

COMMENT ON COLUMN public.global_stats.notifications_received_day
  IS 'Native notification received events during the UTC snapshot day (Cloudflare Analytics Engine).';

COMMENT ON COLUMN public.global_stats.notifications_opened_day
  IS 'Native notification opened events during the UTC snapshot day (Cloudflare Analytics Engine).';

COMMENT ON COLUMN public.global_stats.notifications_failed_day
  IS 'Native notification failed events during the UTC snapshot day (Cloudflare Analytics Engine).';

COMMENT ON COLUMN public.global_stats.notifications_sent_last_month
  IS 'Native notification sent events in the trailing 30 days ending at snapshot day end (Cloudflare Analytics Engine).';

COMMENT ON COLUMN public.global_stats.notifications_opened_last_month
  IS 'Native notification opened events in the trailing 30 days ending at snapshot day end (Cloudflare Analytics Engine).';
