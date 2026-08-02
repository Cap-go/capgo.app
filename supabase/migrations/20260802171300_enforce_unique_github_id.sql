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

ALTER TABLE public.users
ADD CONSTRAINT users_github_id_key UNIQUE (github_id);
