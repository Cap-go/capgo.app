-- Required before migration 20260923143039 when public.manifest is large.
-- That migration refuses a regular CREATE INDEX once the table estimate is
-- above 100000 rows, because that build blocks manifest writes.
-- Run the SINGLE statement below alone in SQL Editor (or psql). Do not mix
-- with other statements in one Editor run if the Editor wraps a transaction —
-- CREATE INDEX CONCURRENTLY cannot run in a transaction.
--
-- Example (psql):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/manifest_version_hash_lookup_index.sql

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_manifest_app_version_id_file_hash
  ON public.manifest USING btree (app_version_id, file_hash)
  INCLUDE (file_size);
