DO $$
DECLARE
  duplicate_github_id bigint;
  duplicate_count bigint;
BEGIN
  SELECT github_id, COUNT(*)
  INTO duplicate_github_id, duplicate_count
  FROM public.users
  WHERE github_id IS NOT NULL
  GROUP BY github_id
  HAVING COUNT(*) > 1
  ORDER BY github_id
  LIMIT 1;

  IF duplicate_github_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce unique GitHub account links: '
      'github_id % is linked to % users',
      duplicate_github_id,
      duplicate_count;
  END IF;
END
$$;

-- Production operators must prebuild this index concurrently with
-- scripts/ops/users_github_id_unique_index.sql before applying the migration.
-- The fallback keeps fresh local/test databases self-contained; on production
-- CREATE INDEX IF NOT EXISTS is a no-op, and the constraint attachment below
-- only holds the table lock briefly.
CREATE UNIQUE INDEX IF NOT EXISTS users_github_id_key
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
      || 'Drop it and rerun scripts/ops/users_github_id_unique_index.sql '
      || 'before applying this migration.';
  END IF;
END
$$;

ALTER TABLE public.users
ADD CONSTRAINT users_github_id_key
UNIQUE USING INDEX users_github_id_key;
