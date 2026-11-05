BEGIN;

SELECT plan(16);

-- These child rows use fake app/bundle identifiers and never alter a shared
-- parent. The transaction rolls back every audit row it creates.
INSERT INTO public.audit_logs (
    created_at,
    table_name,
    record_id,
    operation,
    org_id,
    old_record,
    changed_fields
)
SELECT
    TIMESTAMPTZ '2026-01-01 00:00:00+00'
    + fixture.minute * INTERVAL '1 minute' AS created_at,
    fixture.table_name,
    fixture.record_id,
    fixture.operation,
    fixture.org_id,
    jsonb_build_object(
        'app_id', fixture.app_id, 'version', fixture.version
    ) AS old_record,
    fixture.changed_fields
FROM (
    VALUES
    (
        1,
        'channels',
        'audit-history-first',
        'UPDATE',
        '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::UUID,
        'com.test.audit.bundlehistory', 97001, ARRAY['version']
    ),
    (
        2,
        'channels',
        'audit-history-second',
        'UPDATE',
        '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::UUID,
        'com.test.audit.bundlehistory', 97001, ARRAY['version', 'name']
    ),
    (
        3,
        'channels',
        'audit-history-other-app',
        'UPDATE',
        '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::UUID,
        'com.test.audit.otherapp', 97001, ARRAY['version']
    ),
    (
        4,
        'channels',
        'audit-history-other-bundle',
        'UPDATE',
        '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::UUID,
        'com.test.audit.bundlehistory', 97002, ARRAY['version']
    ),
    (
        5,
        'channels',
        'audit-history-no-version-change',
        'UPDATE',
        '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::UUID,
        'com.test.audit.bundlehistory', 97001, ARRAY['name']
    ),
    (
        6,
        'channels',
        'audit-history-delete',
        'DELETE',
        '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::UUID,
        'com.test.audit.bundlehistory', 97001, ARRAY['version']
    ),
    (
        7,
        'apps',
        'audit-history-other-table',
        'UPDATE',
        '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::UUID,
        'com.test.audit.bundlehistory', 97001, ARRAY['version']
    ),
    (
        8,
        'channels',
        'audit-history-other-org',
        'UPDATE',
        '34a8c55d-2d0f-4652-a43f-684c7a9403ac'::UUID,
        'com.test.audit.bundlehistory', 97001, ARRAY['version']
    )
) AS fixture (
    minute, table_name, record_id, operation,
    org_id, app_id, version, changed_fields
);

-- Match the console's bundle-removal query, including its exact count and RLS.
INSERT INTO public.apikeys (user_id, key, name, rbac_id)
VALUES (
    'c591b04e-cf29-4945-b9a0-776d0672061a',
    'audit-history-test-key', 'audit history test',
    '00000000-0000-4000-8000-000000009701'
);
INSERT INTO public.role_bindings (
    principal_type, principal_id, role_id, scope_type, org_id, granted_by
)
SELECT
    'apikey' AS principal_type,
    '00000000-0000-4000-8000-000000009701' AS principal_id,
    id AS role_id,
    'org' AS scope_type,
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8' AS org_id,
    'c591b04e-cf29-4945-b9a0-776d0672061a' AS granted_by
FROM public.roles
WHERE name = 'org_super_admin';

SET LOCAL ROLE authenticated;
SELECT
    set_config(
        'request.jwt.claims',
        '{"sub":"c591b04e-cf29-4945-b9a0-776d0672061a",'
        || '"role":"authenticated","aal":"aal2"}', true
    );

CREATE TEMP VIEW bundle_removals WITH (security_invoker = true) AS
SELECT
    id,
    record_id,
    user_id,
    created_at
FROM public.audit_logs
WHERE
    table_name = 'channels'
    AND operation = 'UPDATE'
    AND changed_fields @> ARRAY['version']::TEXT[]
    AND old_record ->> 'app_id' = 'com.test.audit.bundlehistory'
    AND old_record ->> 'version' = '97001';

SELECT is(
    (
        public.get_bundle_channel_removals(
            'com.test.audit.bundlehistory', 97001
        )
        ->> 'count'
    )::BIGINT,
    2::BIGINT,
    'count includes only readable removals of this app and bundle'
);
SELECT is(
    public.get_bundle_channel_removals('com.test.audit.bundlehistory', 97001, 1)
    #>> '{data,0,record_id}',
    'audit-history-second',
    'descending history returns the latest removal first'
);
SELECT is(
    public.get_bundle_channel_removals(
        'com.test.audit.bundlehistory', 97001, 1, true
    )
    #>> '{data,0,record_id}',
    'audit-history-first',
    'ascending history returns the earliest removal first'
);
SELECT is(
    public.get_bundle_channel_removals(
        'com.test.audit.bundlehistory',
        97001,
        20,
        false,
        ARRAY['audit-history-first']
    )
    ->> 'count',
    '1',
    'a channel filter limits both the removals and their count'
);
SELECT is(
    public.get_bundle_channel_removals(
        'com.test.audit.bundlehistory', 97001, 20, false, '{}'::TEXT[]
    )
    ->> 'count',
    '0',
    'an empty channel filter matches no removals'
);
SELECT is(
    public.get_bundle_channel_removals(
        'com.test.audit.bundlehistory', 97001, 0
    ),
    '{"data": [], "count": 2}'::JSONB,
    'a zero limit returns the count without page rows'
);
SELECT is(
    public.get_bundle_channel_removals('com.test.audit.missing', 97001),
    '{"data": [], "count": 0}'::JSONB,
    'an unknown app returns an empty page'
);
SELECT is(
    public.get_bundle_channel_removals('com.test.audit.bundlehistory', 97003),
    '{"data": [], "count": 0}'::JSONB,
    'an unknown bundle returns an empty page'
);
SELECT is(
    public.get_bundle_channel_removals('com.test.audit.bundlehistory', 97001),
    (SELECT jsonb_build_object(
        'data', jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC),
        'count', count(*)
    ) FROM bundle_removals AS r),
    'the RPC returns exactly the rows and count visible through RLS'
);

-- This caller has no bindings for either fixture org.
SELECT
    set_config(
        'request.jwt.claims',
        '{"sub":"00000000-0000-4000-8000-000000009701",'
        || '"role":"authenticated","aal":"aal2"}', true
    );
SELECT is(
    public.get_bundle_channel_removals('com.test.audit.bundlehistory', 97001),
    '{"data": [], "count": 0}'::JSONB,
    'a caller without audit permission learns no history or count'
);
RESET ROLE;
SELECT is(
    has_function_privilege(
        'anon',
        'public.get_bundle_channel_removals'
        || '(text,bigint,integer,boolean,text[])',
        'EXECUTE'
    ),
    false,
    'anonymous callers cannot execute the console RPC'
);
SELECT is(
    has_function_privilege(
        'service_role',
        'public.get_bundle_channel_removals'
        || '(text,bigint,integer,boolean,text[])',
        'EXECUTE'
    ),
    false,
    'the console RPC grants no unnecessary service access'
);

SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '', true);
SELECT throws_ok(
    $$SELECT public.get_bundle_channel_removals(
        'com.test.audit.bundlehistory', 97001)$$,
    '42501', null, 'a public caller cannot execute the console RPC'
);
SELECT
    set_config(
        'request.headers', '{"capgkey":"audit-history-invalid-key"}', true
    );
SELECT throws_ok(
    $$SELECT public.get_bundle_channel_removals(
        'com.test.audit.bundlehistory', 97001)$$,
    '42501', null, 'an invalid API key cannot execute the console RPC'
);
SELECT
    set_config(
        'request.headers', '{"capgkey":"audit-history-test-key"}', true
    );
SELECT ok(
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::UUID
    = any(public.audit_logs_allowed_orgs()),
    'the valid org API key has broad audit access through the existing policy'
);
SELECT throws_ok(
    $$SELECT public.get_bundle_channel_removals(
        'com.test.audit.bundlehistory', 97001)$$,
    '42501',
    null,
    'an API key with audit access cannot execute the console-only RPC'
);

SELECT finish();
ROLLBACK;
