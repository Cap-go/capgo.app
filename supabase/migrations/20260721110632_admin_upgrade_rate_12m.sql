ALTER TABLE public.global_stats
  ADD COLUMN IF NOT EXISTS upgrade_rate_12m double precision NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.global_stats.upgrade_rate_12m
  IS 'Percentage of organizations whose last stripe_info.upgraded_at '
     'falls within the trailing 12 calendar months ending at the UTC '
     'snapshot day end (orgs with last stripe_info.upgraded_at in-window / '
     'orgs created by day end * 100).';
