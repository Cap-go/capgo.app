-- Bundle lists filter by app and deletion state before paging by creation time.
-- Keep deleted in the key so parameterized generic plans can use the index for
-- either boolean value without depending on a partial-index predicate.
-- Prebuild concurrently before production deployment; see the rollout steps in
-- scripts/bench/bundle_list_summary.md. IF NOT EXISTS reuses that valid index.
SET lock_timeout = '5s';

-- A failed concurrent prebuild must not be silently accepted as applied.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS idx
    WHERE idx.indexrelid = pg_catalog.to_regclass('public.idx_app_versions_app_deleted_created_at')
      AND NOT (idx.indisvalid AND idx.indisready)
  ) THEN
    RAISE EXCEPTION 'idx_app_versions_app_deleted_created_at exists but is invalid or not ready; drop it concurrently and retry';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_app_versions_app_deleted_created_at
ON public.app_versions (app_id, deleted, created_at DESC);

RESET lock_timeout;
