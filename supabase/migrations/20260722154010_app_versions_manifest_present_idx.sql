-- Permanent partial index for hourly dual-storage reclaim candidate discovery.
-- Migrations cannot use CREATE INDEX CONCURRENTLY (transactional).
-- On large prod DBs, optionally prebuild with scripts/ops/reclaim_supabase_swap_index.sql
-- so CREATE INDEX IF NOT EXISTS is a no-op and avoids a write-blocking build.
-- Drop a same-named INVALID leftover from a failed concurrent build first.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS idx
    JOIN pg_catalog.pg_namespace AS ns ON ns.oid = idx.relnamespace
    JOIN pg_catalog.pg_index AS i ON i.indexrelid = idx.oid
    WHERE ns.nspname = 'public'
      AND idx.relname = 'app_versions_manifest_present_idx'
      AND NOT i.indisvalid
  ) THEN
    DROP INDEX public.app_versions_manifest_present_idx;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS app_versions_manifest_present_idx
  ON public.app_versions USING btree (id)
  WHERE manifest IS NOT NULL;
