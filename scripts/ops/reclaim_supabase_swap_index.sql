-- Optional Capgo-EU pre-deploy: build the candidate index without blocking writes.
-- Prefer deploying migration 20260722154010 instead.
-- If you still need this: run the SINGLE statement below alone in SQL Editor
-- (or psql). Do not mix with other statements in one Editor run if the Editor
-- wraps a transaction — CREATE INDEX CONCURRENTLY cannot run in a transaction.
--
-- Example (psql):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/reclaim_supabase_swap_index.sql

CREATE INDEX CONCURRENTLY IF NOT EXISTS app_versions_manifest_present_idx
  ON public.app_versions USING btree (id)
  WHERE manifest IS NOT NULL;
