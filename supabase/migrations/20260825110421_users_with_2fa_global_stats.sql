ALTER TABLE public.global_stats
  ADD COLUMN IF NOT EXISTS users_with_2fa bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.global_stats.users_with_2fa
  IS 'Snapshot of users with at least one verified MFA factor at UTC day end.';
