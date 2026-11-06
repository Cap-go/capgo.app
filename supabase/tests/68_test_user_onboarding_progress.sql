BEGIN;

SELECT plan(15);

SELECT tests.create_supabase_user(
    'onboarding_progress_user',
    'onboarding_progress_user@test.local'
);

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
        WHERE
            table_schema = 'public'
            AND table_name = 'users'
            AND column_name = 'onboarding'
    ),
    'users.onboarding exists'
);

SELECT is(
    (
        SELECT data_type
        FROM information_schema.columns
        WHERE
            table_schema = 'public'
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

SELECT lives_ok(
    $$UPDATE public.users
    SET onboarding = '{"status":"in_progress","step":"setup","flow":"pre_org","setup_stage":"channel-create"}'::jsonb
    WHERE id = tests.get_supabase_uid('onboarding_progress_user')$$,
    'valid onboarding setup stage is accepted'
);

SELECT throws_ok(
    $$UPDATE public.users
    SET onboarding = '{"status":"in_progress","step":"setup","flow":"pre_org","setup_stage":"unknown"}'::jsonb
    WHERE id = tests.get_supabase_uid('onboarding_progress_user')$$,
    '23514',
    NULL,
    'invalid onboarding setup stage is rejected'
);

SELECT lives_ok(
    $$UPDATE public.users
    SET onboarding = jsonb_build_object('pad', repeat('x', 65525))
    WHERE id = tests.get_supabase_uid('onboarding_progress_user')$$,
    'onboarding jsonb at the 65536-byte limit is accepted'
);

SELECT throws_ok(
    $$UPDATE public.users
    SET onboarding = jsonb_build_object('pad', repeat('x', 65526))
    WHERE id = tests.get_supabase_uid('onboarding_progress_user')$$,
    '23514',
    NULL,
    'onboarding jsonb above the 65536-byte limit is rejected'
);

SELECT throws_ok(
    $$UPDATE public.users
    SET onboarding = '{"status":null,"step":"details","flow":"pre_org"}'::jsonb
    WHERE id = tests.get_supabase_uid('onboarding_progress_user')$$,
    '23514',
    NULL,
    'json null onboarding status is rejected'
);

SELECT lives_ok(
    $$UPDATE public.users
    SET onboarding = '{"abtests":{"onboarding_v6":{"branch":"A","assigned_at":"2026-10-19T10:00:54.000Z"}},"profile_draft":{"first_name":"Partial","last_name":""}}'::jsonb
    WHERE id = tests.get_supabase_uid('onboarding_progress_user')$$,
    'partial profile drafts coexist with server-managed experiment assignments'
);

SELECT lives_ok(
    $$UPDATE public.users
    SET onboarding = '{"version":4,"abtests":{"retained":{"branch":"A"}}}'::jsonb
    WHERE id = tests.get_supabase_uid('onboarding_progress_user')$$,
    'legacy onboarding metadata remains valid'
);

SELECT tests.authenticate_as('onboarding_progress_user');

SELECT lives_ok(
    $$UPDATE public.users
    SET onboarding = onboarding || '{"status":"in_progress","step":"details","flow":"pre_org","profile_completed_at":"2026-10-19T10:00:54.000Z"}'::jsonb
    WHERE id = tests.get_supabase_uid('onboarding_progress_user')$$,
    'owner can update own onboarding progress through RLS'
);

SELECT is(
    (
        SELECT onboarding ->> 'profile_completed_at' FROM public.users
        WHERE id = tests.get_supabase_uid('onboarding_progress_user')
    ),
    '2026-10-19T10:00:54.000Z',
    'owner can persist name confirmation through RLS and onboarding triggers'
);

SELECT tests.clear_authentication();

SELECT * FROM finish(); -- noqa: AM04

ROLLBACK;
