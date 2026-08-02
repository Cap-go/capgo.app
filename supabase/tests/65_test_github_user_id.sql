BEGIN;

SELECT plan(9);

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
  )
ON CONFLICT (id) DO NOTHING;

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

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS unique_constraint
    JOIN pg_catalog.pg_index AS index_meta
      ON index_meta.indexrelid = unique_constraint.conindid
    JOIN pg_catalog.pg_attribute AS indexed_column
      ON indexed_column.attrelid = unique_constraint.conrelid
      AND indexed_column.attname = 'github_id'
      AND NOT indexed_column.attisdropped
    JOIN pg_catalog.pg_class AS idx
      ON idx.oid = index_meta.indexrelid
    JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = idx.relam
    WHERE unique_constraint.conrelid = 'public.users'::regclass
      AND unique_constraint.conname = 'users_github_id_key'
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
  ),
  'the constraint uses the validated GitHub ID index'
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
