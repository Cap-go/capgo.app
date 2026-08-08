ALTER TABLE public.global_stats
  ADD COLUMN IF NOT EXISTS apps_with_preview bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.global_stats.apps_with_preview
  IS 'Number of apps with preview QR enabled (allow_preview = true) at snapshot day end.';
