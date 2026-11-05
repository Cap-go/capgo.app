-- deploy_history SELECT honors the effective channel.read_history permission:
-- org, app and channel scope grants (direct or through a group) and channel
-- overrides.
BEGIN;

SELECT plan(15);

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
    history_label text PRIMARY KEY,
    channel_1 bigint,
    channel_2 bigint
) ON COMMIT DROP;
GRANT ALL ON history_counts TO authenticated;

-- Records what the authenticated caller sees on channels 1 and 2.
CREATE FUNCTION pg_temp.record_history(p_label text)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
    INSERT INTO pg_temp.history_counts (history_label, channel_1, channel_2)
    SELECT
        p_label AS history_label,
        count(*) FILTER (WHERE dh.channel_id = 1) AS channel_1,
        count(*) FILTER (WHERE dh.channel_id = 2) AS channel_2
    FROM public.deploy_history AS dh
    WHERE dh.app_id = 'com.demo.app';
$$;

CREATE FUNCTION pg_temp.record_history_as(p_user text, p_label text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    PERFORM tests.authenticate_as(p_user);
    PERFORM pg_temp.record_history(p_label);
    PERFORM tests.clear_authentication();
    RESET ROLE;
END;
$$;

-- Org owner, no override.
SELECT pg_temp.record_history_as('test_user', 'baseline');

-- Deny channel.read_history on channel 1 for the org owner.
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

SELECT pg_temp.record_history_as('test_user', 'denied');

-- An allow override is not a deny.
UPDATE public.channel_permission_overrides
SET is_allowed = true
WHERE
    principal_id = '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid
    AND channel_id = 1
    AND permission_key = public.rbac_perm_channel_read_history();

SELECT pg_temp.record_history_as('test_user', 'allowed');

-- Removing the override restores visibility.
DELETE FROM public.channel_permission_overrides
WHERE
    principal_id = '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid
    AND channel_id = 1
    AND permission_key = public.rbac_perm_channel_read_history();

SELECT pg_temp.record_history_as('test_user', 'removed');

-- Two org members without org-wide channel.read_history.
SELECT
    tests.create_supabase_user(
        'history_preview_user', 'history_preview_user@test.local'
    ) AS preview_user;
SELECT
    tests.create_supabase_user(
        'history_group_user', 'history_group_user@test.local'
    ) AS group_user;

INSERT INTO public.users (id, email, created_at, updated_at)
SELECT
    tests.get_supabase_uid(fixture.identifier) AS id,
    fixture.email,
    now() AS created_at,
    now() AS updated_at
FROM (
    VALUES
    ('history_preview_user', 'history_preview_user@test.local'),
    ('history_group_user', 'history_group_user@test.local')
) AS fixture (identifier, email)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
SELECT
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid AS org_id,
    tests.get_supabase_uid(fixture.identifier) AS user_id,
    public.rbac_role_org_member() AS rbac_role_name,
    false AS is_invite
FROM (
    VALUES ('history_preview_user'), ('history_group_user')
) AS fixture (identifier);

INSERT INTO public.role_bindings (
    principal_type, principal_id, role_id, scope_type, org_id, granted_by
)
SELECT
    public.rbac_principal_user() AS principal_type,
    tests.get_supabase_uid(fixture.identifier) AS principal_id,
    roles.id AS role_id,
    public.rbac_scope_org() AS scope_type,
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid AS org_id,
    '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid AS granted_by
FROM (
    VALUES ('history_preview_user'), ('history_group_user')
) AS fixture (identifier)
CROSS JOIN public.roles
WHERE
    roles.name = public.rbac_role_org_member()
    AND roles.scope_type = public.rbac_scope_org();

-- history_preview_user: only app binding is app_preview, which grants
-- app.read but not channel.read_history.
INSERT INTO public.role_bindings (
    principal_type,
    principal_id,
    role_id,
    scope_type,
    org_id,
    app_id,
    granted_by
)
SELECT
    public.rbac_principal_user() AS principal_type,
    tests.get_supabase_uid('history_preview_user') AS principal_id,
    roles.id AS role_id,
    public.rbac_scope_app() AS scope_type,
    apps.owner_org AS org_id,
    apps.id AS app_id,
    '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid AS granted_by
FROM public.roles
CROSS JOIN public.apps
WHERE
    roles.name = 'app_preview'
    AND apps.app_id = 'com.demo.app';

SELECT pg_temp.record_history_as('history_preview_user', 'preview_no_grant');

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
    public.rbac_principal_user() AS principal_type,
    tests.get_supabase_uid('history_preview_user') AS principal_id,
    roles.id AS role_id,
    public.rbac_scope_channel() AS scope_type,
    channels.owner_org AS org_id,
    apps.id AS app_id,
    channels.rbac_id AS channel_id,
    '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid AS granted_by
FROM public.channels
INNER JOIN public.apps ON channels.app_id = apps.app_id
CROSS JOIN public.roles
WHERE
    roles.name = 'channel_reader'
    AND channels.id = 2;

SELECT
    pg_temp.record_history_as(
        'history_preview_user', 'preview_channel_binding'
    );

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

SELECT
    pg_temp.record_history_as(
        'history_preview_user', 'preview_allow_override'
    );

-- history_group_user: app_reader on com.demo.app through a group binding.
SELECT pg_temp.record_history_as('history_group_user', 'group_no_grant');

INSERT INTO public.groups (id, org_id, name, created_by)
VALUES (
    '90000000-0000-4000-8000-000000000090',
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    'History readers',
    '6aa76066-55ef-4238-ade6-0b32334a4097'
);

INSERT INTO public.group_members (group_id, user_id)
VALUES (
    '90000000-0000-4000-8000-000000000090',
    tests.get_supabase_uid('history_group_user')
);

INSERT INTO public.role_bindings (
    principal_type,
    principal_id,
    role_id,
    scope_type,
    org_id,
    app_id,
    granted_by
)
SELECT
    public.rbac_principal_group() AS principal_type,
    '90000000-0000-4000-8000-000000000090'::uuid AS principal_id,
    roles.id AS role_id,
    public.rbac_scope_app() AS scope_type,
    apps.owner_org AS org_id,
    apps.id AS app_id,
    '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid AS granted_by
FROM public.roles
CROSS JOIN public.apps
WHERE
    roles.name = 'app_reader'
    AND apps.app_id = 'com.demo.app';

SELECT pg_temp.record_history_as('history_group_user', 'group_app_reader');

SELECT
    ok(
        (
            SELECT hc.channel_1 > 0 AND hc.channel_2 > 0
            FROM history_counts AS hc
            WHERE hc.history_label = 'baseline'
        ),
        'org owner sees history of both channels without an override'
    );

SELECT
    is(
        (
            SELECT hc.channel_1
            FROM history_counts AS hc
            WHERE hc.history_label = 'denied'
        ),
        0::bigint,
        'channel.read_history deny hides that channel history'
    );

SELECT
    is(
        (
            SELECT hc.channel_2
            FROM history_counts AS hc
            WHERE hc.history_label = 'denied'
        ),
        (
            SELECT hc.channel_2
            FROM history_counts AS hc
            WHERE hc.history_label = 'baseline'
        ),
        'deny on one channel keeps other channel history visible'
    );

SELECT
    is(
        (
            SELECT hc.channel_1
            FROM history_counts AS hc
            WHERE hc.history_label = 'allowed'
        ),
        (
            SELECT hc.channel_1
            FROM history_counts AS hc
            WHERE hc.history_label = 'baseline'
        ),
        'an allow override does not hide history'
    );

SELECT
    is(
        (
            SELECT hc.channel_1
            FROM history_counts AS hc
            WHERE hc.history_label = 'removed'
        ),
        (
            SELECT hc.channel_1
            FROM history_counts AS hc
            WHERE hc.history_label = 'baseline'
        ),
        'removing the deny override restores history'
    );

SELECT
    is(
        (
            SELECT hc.channel_1 + hc.channel_2
            FROM history_counts AS hc
            WHERE hc.history_label = 'preview_no_grant'
        ),
        0::bigint,
        'app_preview member without channel.read_history sees no history'
    );

SELECT
    is(
        (
            SELECT hc.channel_2
            FROM history_counts AS hc
            WHERE hc.history_label = 'preview_channel_binding'
        ),
        (
            SELECT hc.channel_2
            FROM history_counts AS hc
            WHERE hc.history_label = 'baseline'
        ),
        'channel-scoped channel_reader binding grants that channel history'
    );

SELECT
    is(
        (
            SELECT hc.channel_1
            FROM history_counts AS hc
            WHERE hc.history_label = 'preview_channel_binding'
        ),
        0::bigint,
        'channel-scoped binding does not grant other channels history'
    );

SELECT
    is(
        (
            SELECT hc.channel_1
            FROM history_counts AS hc
            WHERE hc.history_label = 'preview_allow_override'
        ),
        (
            SELECT hc.channel_1
            FROM history_counts AS hc
            WHERE hc.history_label = 'baseline'
        ),
        'allow override grants that channel history'
    );

SELECT
    is(
        (
            SELECT hc.channel_1 + hc.channel_2
            FROM history_counts AS hc
            WHERE hc.history_label = 'group_no_grant'
        ),
        0::bigint,
        'plain org_member sees no history'
    );

SELECT
    is(
        (
            SELECT hc.channel_1 + hc.channel_2
            FROM history_counts AS hc
            WHERE hc.history_label = 'group_app_reader'
        ),
        (
            SELECT hc.channel_1 + hc.channel_2
            FROM history_counts AS hc
            WHERE hc.history_label = 'baseline'
        ),
        'app_reader through a group grants history of every app channel'
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
        NOT has_function_privilege(
            'anon',
            'rbac_internal.deploy_history_allowed_org_ids()',
            'EXECUTE'
        ),
        'anon cannot execute the allowed-org helper'
    );

SELECT
    ok(
        has_function_privilege(
            'authenticated',
            'rbac_internal.deploy_history_allowed_app_ids()',
            'EXECUTE'
        ),
        'authenticated can execute the helpers for RLS'
    );

SELECT * FROM finish();

ROLLBACK;
