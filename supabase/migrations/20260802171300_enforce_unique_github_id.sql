-- Wait for the concurrent prebuild session to finish before inspecting its
-- index. The transaction lock is released automatically with this migration.
SELECT pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('public.users_github_id_key', 0)
);

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
-- Refuse the blocking fallback on every populated database. Fresh local/test
-- databases are empty here, so they remain self-contained without allowing a
-- missed production pre-deploy step to silently lock writes.
DO $$
BEGIN
  IF pg_catalog.to_regclass('public.users_github_id_key') IS NULL
    AND EXISTS (SELECT 1 FROM public.users LIMIT 1)
  THEN
    RAISE EXCEPTION '%',
      'Prebuild public.users_github_id_key concurrently with '
      || 'scripts/ops/users_github_id_unique_index.sql before applying '
      || 'this migration to a populated database.';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS users_github_id_key
ON public.users (github_id);

-- Keep this index-shape validation synchronized with
-- scripts/ops/users_github_id_unique_index.sql.
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
      || 'Drop it and rerun scripts/ops/users_github_id_unique_index.sql '
      || 'before applying this migration.';
  END IF;
END
$$;

ALTER TABLE public.users
ADD CONSTRAINT users_github_id_key
UNIQUE USING INDEX users_github_id_key;
