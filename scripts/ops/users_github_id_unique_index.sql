-- Required pre-deploy step: build the GitHub identity index without blocking
-- writes. Run this file with psql, which executes each statement in autocommit
-- mode and supports the conditional recovery command below. In SQL Editor,
-- check for and drop an invalid same-named index first, then run the CREATE
-- INDEX statement and validation block separately. CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction.
--
-- Example (psql):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f scripts/ops/users_github_id_unique_index.sql

-- Keep recovery, creation, and validation in one serialized session. An
-- invalid index can also be a concurrent build that another deploy is still
-- running, so a second invocation must wait instead of dropping it.
SELECT pg_catalog.pg_advisory_lock(
    pg_catalog.hashtextextended('public.users_github_id_key', 0)
);

-- A failed concurrent build leaves an invalid same-named index. Generate a
-- concurrent drop only for that recoverable state; valid indexes remain intact.
SELECT format(
  'DROP INDEX CONCURRENTLY %I.%I',
  index_namespace.nspname,
  idx.relname
)
FROM pg_catalog.pg_class AS idx
INNER JOIN pg_catalog.pg_namespace AS index_namespace
  ON idx.relnamespace = index_namespace.oid
INNER JOIN pg_catalog.pg_index AS index_meta
  ON idx.oid = index_meta.indexrelid
WHERE index_namespace.nspname = 'public'
  AND idx.relname = 'users_github_id_key'
  AND NOT index_meta.indisvalid
\gexec

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS users_github_id_key
  ON public.users (github_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS idx
    INNER JOIN pg_catalog.pg_namespace AS idx_ns
      ON idx.relnamespace = idx_ns.oid
    INNER JOIN pg_catalog.pg_index AS index_meta
      ON idx.oid = index_meta.indexrelid
    INNER JOIN pg_catalog.pg_class AS indexed_table
      ON index_meta.indrelid = indexed_table.oid
    INNER JOIN pg_catalog.pg_namespace AS table_ns
      ON indexed_table.relnamespace = table_ns.oid
    INNER JOIN pg_catalog.pg_attribute AS indexed_column
      ON indexed_table.oid = indexed_column.attrelid
      AND indexed_column.attname = 'github_id'
      AND NOT indexed_column.attisdropped
    INNER JOIN pg_catalog.pg_am AS access_method
      ON idx.relam = access_method.oid
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

SELECT pg_catalog.pg_advisory_unlock(
    pg_catalog.hashtextextended('public.users_github_id_key', 0)
);
