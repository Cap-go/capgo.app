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
-- A regular CREATE INDEX takes a write-blocking lock for the whole build.
-- When public.manifest is already large, this migration refuses that build.
-- Prebuild first with scripts/ops/manifest_version_hash_lookup_index.sql,
-- then run the migration. CREATE INDEX IF NOT EXISTS is a no-op once the
-- concurrent index is valid. Empty and small databases (local, CI) still
-- build inline because that lock is short.
-- Drop a same-named INVALID leftover from a failed concurrent build first.
DO $$
DECLARE
  manifest_rows bigint;
  new_index_valid boolean;
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

  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS idx
    JOIN pg_catalog.pg_namespace AS ns ON ns.oid = idx.relnamespace
    JOIN pg_catalog.pg_index AS i ON i.indexrelid = idx.oid
    WHERE ns.nspname = 'public'
      AND idx.relname = 'idx_manifest_app_version_id_file_hash'
      AND i.indisvalid
  ) INTO new_index_valid;

  IF new_index_valid THEN
    RETURN;
  END IF;

  SELECT CASE
    WHEN c.reltuples >= 0 THEN c.reltuples::bigint
    ELSE COALESCE(s.n_live_tup, 0)::bigint
  END
  INTO manifest_rows
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_stat_user_tables AS s ON s.relid = c.oid
  WHERE n.nspname = 'public'
    AND c.relname = 'manifest';

  IF COALESCE(manifest_rows, 0) > 100000 THEN
    RAISE EXCEPTION
      'public.manifest has about % rows. Build idx_manifest_app_version_id_file_hash with CREATE INDEX CONCURRENTLY before this migration: scripts/ops/manifest_version_hash_lookup_index.sql',
      manifest_rows;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_manifest_app_version_id_file_hash
  ON public.manifest USING btree (app_version_id, file_hash)
  INCLUDE (file_size);

DROP INDEX IF EXISTS public.idx_manifest_app_version_id;
