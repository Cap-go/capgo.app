-- Required pre-deploy step: build the GitHub identity index without blocking
-- writes. Run this file with psql, which executes each statement in autocommit
-- mode. In SQL Editor, run the CREATE INDEX statement alone, then run the
-- validation block separately. CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction.
--
-- Example (psql):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f scripts/ops/users_github_id_unique_index.sql

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS users_github_id_key
  ON public.users (github_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS idx
    JOIN pg_catalog.pg_namespace AS idx_ns
      ON idx_ns.oid = idx.relnamespace
    JOIN pg_catalog.pg_index AS index_meta
      ON index_meta.indexrelid = idx.oid
    JOIN pg_catalog.pg_class AS indexed_table
      ON indexed_table.oid = index_meta.indrelid
    JOIN pg_catalog.pg_namespace AS table_ns
      ON table_ns.oid = indexed_table.relnamespace
    JOIN pg_catalog.pg_attribute AS indexed_column
      ON indexed_column.attrelid = indexed_table.oid
      AND indexed_column.attname = 'github_id'
      AND NOT indexed_column.attisdropped
    JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = idx.relam
    WHERE idx_ns.nspname = 'public'
      AND idx.relname = 'users_github_id_key'
      AND table_ns.nspname = 'public'
      AND indexed_table.relname = 'users'
      AND index_meta.indisvalid
      AND index_meta.indisready
      AND index_meta.indisunique
      AND index_meta.indislive
      AND NOT index_meta.indnullsnotdistinct
      AND index_meta.indpred IS NULL
      AND index_meta.indexprs IS NULL
      AND index_meta.indnkeyatts = 1
      AND index_meta.indnatts = 1
      AND index_meta.indkey[0] = indexed_column.attnum
      AND access_method.amname = 'btree'
  ) THEN
    RAISE EXCEPTION '%',
      'Index public.users_github_id_key is not a valid, ready, unique '
      || 'btree index on public.users(github_id) with NULLS DISTINCT. '
      || 'Drop it and rerun this script.';
  END IF;
END
$$;
