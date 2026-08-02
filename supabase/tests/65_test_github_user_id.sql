BEGIN;

SELECT plan(8);

SELECT tests.create_supabase_user(
  'github_id_unique_first',
  'github_id_unique_first@test.local'
);
SELECT tests.create_supabase_user(
  'github_id_unique_second',
  'github_id_unique_second@test.local'
);

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES
  (
    tests.get_supabase_uid('github_id_unique_first'),
    'github_id_unique_first@test.local',
    NOW(),
    NOW()
  ),
  (
    tests.get_supabase_uid('github_id_unique_second'),
    'github_id_unique_second@test.local',
    NOW(),
    NOW()
  );

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

SELECT is(
  (
    SELECT contype::text
    FROM pg_constraint
    WHERE conrelid = 'public.users'::regclass
      AND conname = 'users_github_id_key'
  ),
  'u',
  'users.github_id has the named unique constraint'
);

UPDATE public.users
SET github_id = 123456789
WHERE id = tests.get_supabase_uid('github_id_unique_first');

SELECT throws_ok(
  $$
    UPDATE public.users
    SET github_id = 123456789
    WHERE id = tests.get_supabase_uid('github_id_unique_second');
  $$,
  '23505',
  'duplicate key value violates unique constraint "users_github_id_key"',
  'different users cannot save the same non-null GitHub ID'
);

SELECT lives_ok(
  $$
    UPDATE public.users
    SET github_id = NULL
    WHERE id IN (
      tests.get_supabase_uid('github_id_unique_first'),
      tests.get_supabase_uid('github_id_unique_second')
    );
  $$,
  'multiple users may have a null GitHub ID'
);

UPDATE public.users
SET github_id = 123456789
WHERE id = tests.get_supabase_uid('github_id_unique_first');

SELECT lives_ok(
  $$
    UPDATE public.users
    SET github_id = 123456789
    WHERE id = tests.get_supabase_uid('github_id_unique_first');
  $$,
  'a user may re-save their own GitHub ID'
);

SELECT lives_ok(
  $$
    UPDATE public.users
    SET github_id = NULL
    WHERE id = tests.get_supabase_uid('github_id_unique_first');

    UPDATE public.users
    SET github_id = 123456789
    WHERE id = tests.get_supabase_uid('github_id_unique_second');
  $$,
  'clearing a GitHub link lets another user claim that ID'
);

SELECT * FROM finish(); -- noqa: AM04

ROLLBACK;
