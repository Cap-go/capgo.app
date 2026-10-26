-- deploy_history SELECT honors the effective channel.read_history permission:
-- the app-level grant, channel-scoped bindings and channel overrides.
BEGIN;

SELECT plan(13);

-- Seed: com.demo.app channel 1 (production) has deploy_history rows.
-- Add one row on channel 2 so a permitted channel has visible history.
INSERT INTO public.deploy_history (
    channel_id, app_id, version_id, deployed_at, owner_org, created_by
)
VALUES (
    2,
    'com.demo.app',
    3,
    now(),
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid,
    '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid
);

CREATE TEMP TABLE history_counts (
    label text PRIMARY KEY,
    channel_1 bigint,
    channel_2 bigint
) ON COMMIT DROP;
GRANT ALL ON history_counts TO authenticated;

-- Baseline: no override.
SELECT tests.authenticate_as('test_user');
INSERT INTO history_counts
SELECT
    'baseline',
    count(*) FILTER (WHERE channel_id = 1),
    count(*) FILTER (WHERE channel_id = 2)
FROM public.deploy_history
WHERE app_id = 'com.demo.app';
SELECT tests.clear_authentication();
RESET ROLE;

-- Deny channel.read_history on channel 1 for the test user.
INSERT INTO public.channel_permission_overrides (
    principal_type, principal_id, channel_id, permission_key, is_allowed
)
VALUES (
    public.rbac_principal_user(),
    '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid,
    1,
    public.rbac_perm_channel_read_history(),
    false
);

SELECT tests.authenticate_as('test_user');
INSERT INTO history_counts
SELECT
    'denied',
    count(*) FILTER (WHERE channel_id = 1),
    count(*) FILTER (WHERE channel_id = 2)
FROM public.deploy_history
WHERE app_id = 'com.demo.app';
SELECT tests.clear_authentication();
RESET ROLE;

-- An allow override is not a deny.
UPDATE public.channel_permission_overrides
SET is_allowed = true
WHERE
    principal_id = '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid
    AND channel_id = 1
    AND permission_key = public.rbac_perm_channel_read_history();

SELECT tests.authenticate_as('test_user');
INSERT INTO history_counts
SELECT
    'allowed',
    count(*) FILTER (WHERE channel_id = 1),
    count(*) FILTER (WHERE channel_id = 2)
FROM public.deploy_history
WHERE app_id = 'com.demo.app';
SELECT tests.clear_authentication();
RESET ROLE;

-- Removing the override restores visibility.
DELETE FROM public.channel_permission_overrides
WHERE
    principal_id = '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid
    AND channel_id = 1
    AND permission_key = public.rbac_perm_channel_read_history();

SELECT tests.authenticate_as('test_user');
INSERT INTO history_counts
SELECT
    'removed',
    count(*) FILTER (WHERE channel_id = 1),
    count(*) FILTER (WHERE channel_id = 2)
FROM public.deploy_history
WHERE app_id = 'com.demo.app';
SELECT tests.clear_authentication();
RESET ROLE;

-- An org member whose only app binding is app_preview: it grants app.read but
-- not channel.read_history.
SELECT
    tests.create_supabase_user(
        'history_preview_user', 'history_preview_user@test.local'
    );

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES (
    tests.get_supabase_uid('history_preview_user'),
    'history_preview_user@test.local',
    now(),
    now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
VALUES (
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    tests.get_supabase_uid('history_preview_user'),
    public.rbac_role_org_member(),
    false
);

INSERT INTO public.role_bindings (
    principal_type, principal_id, role_id, scope_type, org_id, granted_by
)
SELECT
    public.rbac_principal_user(),
    tests.get_supabase_uid('history_preview_user'),
    roles.id,
    public.rbac_scope_org(),
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid,
    '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid
FROM public.roles
WHERE
    roles.name = public.rbac_role_org_member()
    AND roles.scope_type = public.rbac_scope_org();

INSERT INTO public.role_bindings (
    principal_type, principal_id, role_id, scope_type, org_id, app_id, granted_by
)
SELECT
    public.rbac_principal_user(),
    tests.get_supabase_uid('history_preview_user'),
    roles.id,
    public.rbac_scope_app(),
    apps.owner_org,
    apps.id,
    '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid
FROM public.roles
CROSS JOIN public.apps
WHERE
    roles.name = 'app_preview'
    AND apps.app_id = 'com.demo.app';

SELECT tests.authenticate_as('history_preview_user');
INSERT INTO history_counts
SELECT
    'preview_no_grant',
    count(*) FILTER (WHERE channel_id = 1),
    count(*) FILTER (WHERE channel_id = 2)
FROM public.deploy_history
WHERE app_id = 'com.demo.app';
SELECT tests.clear_authentication();
RESET ROLE;

-- A channel-scoped channel_reader binding grants history on channel 2 only.
INSERT INTO public.role_bindings (
    principal_type,
    principal_id,
    role_id,
    scope_type,
    org_id,
    app_id,
    channel_id,
    granted_by
)
SELECT
    public.rbac_principal_user(),
    tests.get_supabase_uid('history_preview_user'),
    roles.id,
    public.rbac_scope_channel(),
    channels.owner_org,
    apps.id,
    channels.rbac_id,
    '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid
FROM public.channels
INNER JOIN public.apps ON channels.app_id = apps.app_id
CROSS JOIN public.roles
WHERE
    roles.name = 'channel_reader'
    AND channels.id = 2;

SELECT tests.authenticate_as('history_preview_user');
INSERT INTO history_counts
SELECT
    'preview_channel_binding',
    count(*) FILTER (WHERE channel_id = 1),
    count(*) FILTER (WHERE channel_id = 2)
FROM public.deploy_history
WHERE app_id = 'com.demo.app';
SELECT tests.clear_authentication();
RESET ROLE;

-- An explicit allow override grants history on channel 1.
INSERT INTO public.channel_permission_overrides (
    principal_type, principal_id, channel_id, permission_key, is_allowed
)
VALUES (
    public.rbac_principal_user(),
    tests.get_supabase_uid('history_preview_user'),
    1,
    public.rbac_perm_channel_read_history(),
    true
);

SELECT tests.authenticate_as('history_preview_user');
INSERT INTO history_counts
SELECT
    'preview_allow_override',
    count(*) FILTER (WHERE channel_id = 1),
    count(*) FILTER (WHERE channel_id = 2)
FROM public.deploy_history
WHERE app_id = 'com.demo.app';
SELECT tests.clear_authentication();
RESET ROLE;

SELECT
    is(
        (
            SELECT channel_1 > 0 FROM history_counts
            WHERE label = 'baseline'
        ),
        true,
        'member sees channel 1 history without an override'
    );

SELECT
    is(
        (
            SELECT channel_2 > 0 FROM history_counts
            WHERE label = 'baseline'
        ),
        true,
        'member sees channel 2 history without an override'
    );

SELECT
    is(
        (
            SELECT channel_1 FROM history_counts
            WHERE label = 'denied'
        ),
        0::bigint,
        'channel.read_history deny hides that channel history'
    );

SELECT
    is(
        (
            SELECT channel_2 FROM history_counts
            WHERE label = 'denied'
        ),
        (
            SELECT channel_2 FROM history_counts
            WHERE label = 'baseline'
        ),
        'deny on one channel keeps other channel history visible'
    );

SELECT
    is(
        (
            SELECT channel_1 FROM history_counts
            WHERE label = 'allowed'
        ),
        (
            SELECT channel_1 FROM history_counts
            WHERE label = 'baseline'
        ),
        'an allow override does not hide history'
    );

SELECT
    is(
        (
            SELECT channel_1 FROM history_counts
            WHERE label = 'removed'
        ),
        (
            SELECT channel_1 FROM history_counts
            WHERE label = 'baseline'
        ),
        'removing the deny override restores history'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM pg_policies
            WHERE
                schemaname = 'public'
                AND tablename = 'deploy_history'
                AND permissive = 'PERMISSIVE'
                AND cmd IN ('SELECT', 'ALL')
        ),
        1::bigint,
        'deploy_history keeps a single permissive SELECT policy'
    );

SELECT
    ok(
        NOT has_function_privilege(
            'anon',
            'rbac_internal.deploy_history_denied_channel_ids()',
            'EXECUTE'
        ),
        'anon cannot execute the deny helper'
    );

SELECT
    ok(
        has_function_privilege(
            'authenticated',
            'rbac_internal.deploy_history_denied_channel_ids()',
            'EXECUTE'
        ),
        'authenticated can execute the deny helper for RLS'
    );

SELECT
    is(
        (
            SELECT channel_1 + channel_2
            FROM history_counts
            WHERE label = 'preview_no_grant'
        ),
        0::bigint,
        'app_preview member without channel.read_history sees no history'
    );

SELECT
    is(
        (
            SELECT channel_2
            FROM history_counts
            WHERE label = 'preview_channel_binding'
        ),
        (SELECT channel_2 FROM history_counts WHERE label = 'baseline'),
        'channel-scoped channel_reader binding grants that channel history'
    );

SELECT
    is(
        (
            SELECT channel_1
            FROM history_counts
            WHERE label = 'preview_channel_binding'
        ),
        0::bigint,
        'channel-scoped binding does not grant other channels history'
    );

SELECT
    is(
        (
            SELECT channel_1
            FROM history_counts
            WHERE label = 'preview_allow_override'
        ),
        (SELECT channel_1 FROM history_counts WHERE label = 'baseline'),
        'allow override grants that channel history'
    );

SELECT * FROM finish();

ROLLBACK;
