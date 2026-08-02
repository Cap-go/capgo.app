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
      'Cannot enforce unique GitHub account links: github_id % is linked to % users',
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

ALTER TABLE public.users
ADD CONSTRAINT users_github_id_key
UNIQUE USING INDEX users_github_id_key;
