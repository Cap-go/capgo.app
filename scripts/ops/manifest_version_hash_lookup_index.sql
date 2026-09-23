-- Optional pre-deploy: build the manifest_size lookup index without blocking writes.
-- Prefer deploying migration 20260923143039 instead.
-- If you still need this: run the SINGLE statement below alone in SQL Editor
-- (or psql). Do not mix with other statements in one Editor run if the Editor
-- wraps a transaction — CREATE INDEX CONCURRENTLY cannot run in a transaction.
--
-- Example (psql):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/manifest_version_hash_lookup_index.sql

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_manifest_app_version_id_file_hash
  ON public.manifest USING btree (app_version_id, file_hash)
  INCLUDE (file_size);
