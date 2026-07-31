BEGIN;

SELECT plan(5);

SELECT ok(
    to_regprocedure('public.cleanup_tmp_users()') IS NOT NULL,
    'cleanup_tmp_users exists'
);

SELECT tests.authenticate_as_service_role();

SELECT ok(
    (
        SELECT count(*)::int
        FROM public.cron_tasks
        WHERE
            name = 'cleanup_tmp_users'
            AND enabled = TRUE
            AND task_type = 'function'::public.cron_task_type
            AND target = 'public.cleanup_tmp_users()'
            AND minute_interval = 1
    ) = 1,
    'cron_tasks contains cleanup_tmp_users per-minute task'
);

INSERT INTO public.tmp_users (
    email,
    org_id,
    rbac_role_name,
    invite_magic_string,
    future_uuid,
    first_name,
    last_name,
    created_at,
    updated_at
)
VALUES
(
    'tmp_cleanup_old@capgo.app',
    '22dbad8a-b885-4309-9b3b-a09f8460fb6d',
    public.rbac_role_org_member(),
    'tmp_cleanup_old_magic',
    gen_random_uuid(),
    'Tmp',
    'Old',
    now() - interval '8 days',
    now() - interval '8 days'
),
(
    'tmp_cleanup_fresh@capgo.app',
    '22dbad8a-b885-4309-9b3b-a09f8460fb6d',
    public.rbac_role_org_member(),
    'tmp_cleanup_fresh_magic',
    gen_random_uuid(),
    'Tmp',
    'Fresh',
    now() - interval '2 days',
    now() - interval '2 days'
),
(
    'tmp_cleanup_resend@capgo.app',
    '22dbad8a-b885-4309-9b3b-a09f8460fb6d',
    public.rbac_role_org_member(),
    'tmp_cleanup_resend_magic',
    gen_random_uuid(),
    'Tmp',
    'Resend',
    now() - interval '8 days',
    now() - interval '2 days'
);

SELECT public.cleanup_tmp_users();

SELECT is(
    (
        SELECT count(*)::int FROM public.tmp_users
        WHERE invite_magic_string = 'tmp_cleanup_old_magic'
    ),
    0,
    'cleanup_tmp_users deletes invites older than 7 days'
);

SELECT is(
    (
        SELECT count(*)::int FROM public.tmp_users
        WHERE invite_magic_string = 'tmp_cleanup_fresh_magic'
    ),
    1,
    'cleanup_tmp_users keeps fresh invites'
);

SELECT is(
    (
        SELECT count(*)::int FROM public.tmp_users
        WHERE invite_magic_string = 'tmp_cleanup_resend_magic'
    ),
    1,
    'cleanup_tmp_users keeps invites with recent updated_at'
);

SELECT tests.clear_authentication();

SELECT * FROM finish(); -- noqa: AM04

ROLLBACK;
