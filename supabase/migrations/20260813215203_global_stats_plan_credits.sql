ALTER TABLE public.global_stats
  ADD COLUMN IF NOT EXISTS plan_credits integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.global_stats.plan_credits
  IS 'Orgs with remaining unexpired usage credits and no active Stripe plan or trial at snapshot day end.';
