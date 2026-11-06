BEGIN;

SELECT plan(9);

-- The RLS readable-set helpers must stay set-based: one bounded computation per
-- statement, no permission check per app or per org.
SELECT
    is(
        (SELECT prosrc FROM pg_proc WHERE oid = 'public.apps_readable_app_ids()'::regprocedure) ILIKE '%rbac_check_permission_direct%',
        false,
        'apps_readable_app_ids() does not re-check permissions once per app'
    );

SELECT
    is(
        (SELECT provolatile FROM pg_proc WHERE oid = 'public.usage_credit_readable_org_ids()'::regprocedure),
        's'::"char",
        'usage_credit_readable_org_ids() is STABLE so the ledger view can push org filters down'
    );

SELECT
    is(
        (SELECT prosrc FROM pg_proc WHERE oid = 'public.usage_credit_readable_org_ids()'::regprocedure) ILIKE '%FROM public.orgs%',
        false,
        'usage_credit_readable_org_ids() does not scan every org'
    );

-- Fixtures: API keys owned by the demo user with different bindings.
INSERT INTO public.apikeys (id, user_id, key, name, rbac_id) VALUES
(94001, '6aa76066-55ef-4238-ade6-0b32334a4097', 'perf-rls-org-key', 'perf org', '00000000-0000-4000-8000-000000009401'),
(94002, '6aa76066-55ef-4238-ade6-0b32334a4097', 'perf-rls-app-key', 'perf app', '00000000-0000-4000-8000-000000009402'),
(94003, '6aa76066-55ef-4238-ade6-0b32334a4097', 'perf-rls-bad-scope-key', 'perf bad', '00000000-0000-4000-8000-000000009403'),
(94004, '6aa76066-55ef-4238-ade6-0b32334a4097', 'perf-rls-expired-key', 'perf expired', '00000000-0000-4000-8000-000000009404');

INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, app_id, granted_by, expires_at)
SELECT
    'apikey',
    b.principal_id,
    (SELECT id FROM public.roles WHERE name = b.role_name),
    b.scope_type,
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    CASE WHEN b.scope_type = 'app' THEN (SELECT id FROM public.apps WHERE app_id = 'com.demo.app') END,
    '6aa76066-55ef-4238-ade6-0b32334a4097',
    b.expires_at
FROM (VALUES
    ('00000000-0000-4000-8000-000000009401'::uuid, 'org_admin', 'org', NULL::timestamptz),
    ('00000000-0000-4000-8000-000000009402'::uuid, 'app_reader', 'app', NULL::timestamptz),
    ('00000000-0000-4000-8000-000000009404'::uuid, 'org_admin', 'org', now() - interval '1 day')
) AS b (principal_id, role_name, scope_type, expires_at);

-- Malformed binding: an app-scoped role bound at org scope must not grant reads.
-- The role_bindings trigger rejects it, so insert it with triggers bypassed.
SET LOCAL session_replication_role = replica;
INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by)
VALUES (
    'apikey',
    '00000000-0000-4000-8000-000000009403',
    (SELECT id FROM public.roles WHERE name = 'app_admin'),
    'org',
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    '6aa76066-55ef-4238-ade6-0b32334a4097'
);
SET LOCAL session_replication_role = origin;

SET LOCAL ROLE anon;

SELECT set_config('request.headers', '{"capgkey":"perf-rls-org-key"}', true);
SELECT
    ok(
        'com.demo.app' = ANY(public.apps_readable_app_ids()),
        'org-scoped API key reads the org apps'
    );
SELECT
    ok(
        '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid = ANY(public.usage_credit_readable_org_ids()),
        'org admin API key reads the org usage credits'
    );

SELECT set_config('request.headers', '{"capgkey":"perf-rls-app-key"}', true);
SELECT
    is(
        public.apps_readable_app_ids(),
        ARRAY['com.demo.app']::character varying[],
        'app-scoped API key reads only its app'
    );
SELECT
    is(
        public.usage_credit_readable_org_ids(),
        '{}'::uuid[],
        'app-scoped API key cannot read org usage credits'
    );

SELECT set_config('request.headers', '{"capgkey":"perf-rls-bad-scope-key"}', true);
SELECT
    is(
        public.apps_readable_app_ids(),
        '{}'::character varying[],
        'binding whose role scope differs from the binding scope grants nothing'
    );

SELECT set_config('request.headers', '{"capgkey":"perf-rls-expired-key"}', true);
SELECT
    is(
        public.apps_readable_app_ids(),
        '{}'::character varying[],
        'expired binding grants nothing'
    );

SELECT * FROM finish();

ROLLBACK;
