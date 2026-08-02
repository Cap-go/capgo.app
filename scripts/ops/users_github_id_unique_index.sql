-- Required pre-deploy step: build the GitHub identity index without blocking writes.
-- Run the SINGLE statement below alone in SQL Editor (or psql). Do not mix it
-- with other statements in one Editor run if the Editor wraps a transaction:
-- CREATE INDEX CONCURRENTLY cannot run in a transaction.
--
-- Example (psql):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/users_github_id_unique_index.sql

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS users_github_id_key
  ON public.users (github_id);
