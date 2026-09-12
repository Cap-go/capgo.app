CREATE INDEX IF NOT EXISTS users_onboarding_abtests_gin_idx
ON public.users
USING gin ((onboarding -> 'abtests'));

COMMENT ON INDEX public.users_onboarding_abtests_gin_idx IS
  'Bounds platform admin A/B distribution reads to users assigned to configured onboarding experiments.';
