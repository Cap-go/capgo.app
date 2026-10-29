-- Bundle lists filter by app and deletion state before paging by creation time.
-- Keep deleted in the key so parameterized generic plans can use the index for
-- either boolean value without depending on a partial-index predicate.
-- Prebuild concurrently before production deployment; see the rollout steps in
-- scripts/bench/bundle_list_summary.md. IF NOT EXISTS reuses that valid index.
SET lock_timeout = '5s';

-- Reuse only the exact expected index after a completed concurrent prebuild.
DO $$
BEGIN
  IF pg_catalog.to_regclass('public.idx_app_versions_app_deleted_created_at') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index AS idx
      WHERE idx.indexrelid = pg_catalog.to_regclass('public.idx_app_versions_app_deleted_created_at')
    ) THEN
    RAISE EXCEPTION 'idx_app_versions_app_deleted_created_at exists but is not an index; inspect it before retrying';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS idx
    WHERE idx.indexrelid = pg_catalog.to_regclass('public.idx_app_versions_app_deleted_created_at')
      AND NOT (idx.indisvalid AND idx.indisready)
  ) THEN
    RAISE EXCEPTION 'idx_app_versions_app_deleted_created_at exists but is invalid or not ready; drop it concurrently and retry';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS idx
    WHERE idx.indexrelid = pg_catalog.to_regclass('public.idx_app_versions_app_deleted_created_at')
      AND pg_catalog.pg_get_indexdef(idx.indexrelid) <>
        'CREATE INDEX idx_app_versions_app_deleted_created_at ON public.app_versions USING btree '
        || '(app_id, deleted, created_at DESC)'
  ) THEN
    RAISE EXCEPTION 'idx_app_versions_app_deleted_created_at exists with an unexpected definition; inspect it before retrying';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_app_versions_app_deleted_created_at
ON public.app_versions (app_id, deleted, created_at DESC);

RESET lock_timeout;
