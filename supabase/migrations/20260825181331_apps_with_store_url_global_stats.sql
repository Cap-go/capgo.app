ALTER TABLE public.global_stats
  ADD COLUMN IF NOT EXISTS apps_with_store_url bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.global_stats.apps_with_store_url
  IS 'Number of apps with at least one App Store or Google Play link at snapshot day end.';
