-- POST /updates/manifest_size looks up file_size by (app_version_id, file_hash).
-- idx_manifest_app_version_id only supports the version prefix, so the planner
-- can start from the global idx_manifest_file_hash and scan repeated hashes.
-- This composite is the nested-loop probe: one version, then one hash.
-- Leftmost app_version_id still serves version-scoped manifest reads, so the
-- single-column index is redundant once this exists.
--
-- Execution: plugin read replica, once per manifest_size request.
-- Cardinality: one app version (or the requested version ids) times the
-- distinct hashes in that bundle (thousands), not manifest table size.
--
-- Migrations cannot use CREATE INDEX CONCURRENTLY (transactional).
-- On large prod DBs, prebuild with scripts/ops/manifest_version_hash_lookup_index.sql
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
      AND idx.relname = 'idx_manifest_app_version_id_file_hash'
      AND NOT i.indisvalid
  ) THEN
    DROP INDEX public.idx_manifest_app_version_id_file_hash;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_manifest_app_version_id_file_hash
  ON public.manifest USING btree (app_version_id, file_hash)
  INCLUDE (file_size);

DROP INDEX IF EXISTS public.idx_manifest_app_version_id;
