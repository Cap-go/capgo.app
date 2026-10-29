-- Bundle lists filter by app and deletion state before paging by creation time.
-- Keep deleted in the key so parameterized generic plans can use the index for
-- either boolean value without depending on a partial-index predicate.
-- Prebuild concurrently before production deployment; see the rollout steps in
-- scripts/bench/bundle_list_summary.md. IF NOT EXISTS reuses that valid index.
SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_app_versions_app_deleted_created_at
ON public.app_versions (app_id, deleted, created_at DESC);

RESET lock_timeout;
