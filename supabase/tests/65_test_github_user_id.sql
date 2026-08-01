BEGIN;

SELECT plan(3);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'github_id'
  ),
  'users.github_id exists'
);

SELECT is(
  (
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'github_id'
  ),
  'bigint',
  'users.github_id is bigint'
);

SELECT is(
  (
    SELECT is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'github_id'
  ),
  'YES',
  'users.github_id is nullable'
);

SELECT * FROM finish(); -- noqa: AM04

ROLLBACK;
