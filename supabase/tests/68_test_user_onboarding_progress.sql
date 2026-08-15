BEGIN;

SELECT plan(9);

SELECT tests.create_supabase_user('onboarding_progress_user', 'onboarding_progress_user@test.local');

INSERT INTO public.users (id, email, first_name, last_name)
VALUES (
  tests.get_supabase_uid('onboarding_progress_user'),
  'onboarding_progress_user@test.local',
  'Onboard',
  'Progress'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'onboarding'
  ),
  'users.onboarding exists'
);

SELECT is(
  (
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'onboarding'
  ),
  'jsonb',
  'users.onboarding is jsonb'
);

SELECT is(
  (
    SELECT onboarding
    FROM public.users
    WHERE id = tests.get_supabase_uid('onboarding_progress_user')
  ),
  '{}'::jsonb,
  'users.onboarding defaults to empty object'
);

SELECT lives_ok(
  $$UPDATE public.users
    SET onboarding = '{"status":"in_progress","step":"organization","flow":"pre_org","intent":"ota","app_name":"Acme"}'::jsonb
    WHERE id = tests.get_supabase_uid('onboarding_progress_user')$$,
  'valid onboarding progress is accepted'
);

SELECT throws_ok(
  $$UPDATE public.users
    SET onboarding = '{"status":"nope","step":"details","flow":"pre_org"}'::jsonb
    WHERE id = tests.get_supabase_uid('onboarding_progress_user')$$,
  '23514',
  NULL,
  'invalid onboarding status is rejected'
);

SELECT throws_ok(
  $$UPDATE public.users
    SET onboarding = '{"status":"in_progress","step":"unknown","flow":"pre_org"}'::jsonb
    WHERE id = tests.get_supabase_uid('onboarding_progress_user')$$,
  '23514',
  NULL,
  'invalid onboarding step is rejected'
);

SELECT throws_ok(
  $$UPDATE public.users
    SET onboarding = jsonb_build_object('pad', repeat('x', 9000))
    WHERE id = tests.get_supabase_uid('onboarding_progress_user')$$,
  '23514',
  NULL,
  'oversized onboarding jsonb is rejected'
);

SELECT throws_ok(
  $$UPDATE public.users
    SET onboarding = '{"status":null,"step":"details","flow":"pre_org"}'::jsonb
    WHERE id = tests.get_supabase_uid('onboarding_progress_user')$$,
  '23514',
  NULL,
  'json null onboarding status is rejected'
);

SELECT tests.authenticate_as('onboarding_progress_user');

SELECT lives_ok(
  $$UPDATE public.users
    SET onboarding = '{"status":"in_progress","step":"details","flow":"pre_org"}'::jsonb
    WHERE id = tests.get_supabase_uid('onboarding_progress_user')$$,
  'owner can update own onboarding progress through RLS'
);

SELECT tests.clear_authentication();

SELECT * FROM finish(); -- noqa: AM04

ROLLBACK;
