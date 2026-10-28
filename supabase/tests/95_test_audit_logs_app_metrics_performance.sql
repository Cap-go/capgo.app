BEGIN;

SELECT plan(9);

-- audit_logs RLS computes a bounded org set once per statement.
SELECT
    is(
        (SELECT provolatile FROM pg_proc WHERE oid = 'public.audit_logs_allowed_orgs()'::regprocedure),
        's'::"char",
        'audit_logs_allowed_orgs() is STABLE'
    );

SELECT
    is(
        (SELECT prosrc FROM pg_proc WHERE oid = 'public.audit_logs_allowed_orgs()'::regprocedure) ILIKE '%FROM public.orgs%',
        false,
        'audit_logs_allowed_orgs() does not scan every org'
    );

-- The org owner (direct org_super_admin binding) can read its audit logs.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"c591b04e-cf29-4945-b9a0-776d0672061a","role":"authenticated","aal":"aal2"}', true);
SELECT
    ok(
        '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid = ANY(public.audit_logs_allowed_orgs()),
        'org owner reads the org audit logs'
    );
RESET ROLE;

-- An API key without org-level audit permission reads nothing.
INSERT INTO public.apikeys (id, user_id, key, name, rbac_id) VALUES
(95001, '6aa76066-55ef-4238-ade6-0b32334a4097', 'perf-audit-app-key', 'perf audit app', '00000000-0000-4000-8000-000000009501');
INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, app_id, granted_by)
SELECT
    'apikey',
    '00000000-0000-4000-8000-000000009501',
    (SELECT id FROM public.roles WHERE name = 'app_admin'),
    'app',
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    (SELECT id FROM public.apps WHERE app_id = 'com.demo.app'),
    '6aa76066-55ef-4238-ade6-0b32334a4097';

SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '', true);
SELECT set_config('request.headers', '{"capgkey":"perf-audit-app-key"}', true);
SELECT
    is(
        public.audit_logs_allowed_orgs(),
        '{}'::uuid[],
        'app-scoped API key cannot read org audit logs'
    );
RESET ROLE;
SELECT set_config('request.headers', '', true);

-- seed_get_app_metrics_caches() returns one row per org app and day, with
-- daily_version summed across versions and missing days filled with zeros.
DELETE FROM public.daily_mau WHERE app_id = 'com.demo.app' AND date BETWEEN DATE '2023-03-01' AND DATE '2023-03-03';
DELETE FROM public.daily_version WHERE app_id = 'com.demo.app' AND date BETWEEN DATE '2023-03-01' AND DATE '2023-03-03';
INSERT INTO public.daily_mau (app_id, date, mau) VALUES ('com.demo.app', DATE '2023-03-02', 7);
INSERT INTO public.daily_version (app_id, date, version_name, get, fail, install, uninstall) VALUES
('com.demo.app', DATE '2023-03-02', '1.0.0', 3, 1, 2, 0),
('com.demo.app', DATE '2023-03-02', '1.0.1', 4, 0, 5, 1);

CREATE TEMP TABLE perf_metrics AS
SELECT m.*
FROM
    pg_catalog.jsonb_to_recordset(
        (public.seed_get_app_metrics_caches('046a36ac-e03c-4590-9257-bd6c9dba9ee8', DATE '2023-03-01', DATE '2023-03-03')).response
    ) AS m (
        app_id character varying,
        date date,
        mau bigint,
        storage bigint,
        bandwidth bigint,
        build_time_unit bigint,
        get bigint,
        fail bigint,
        install bigint,
        uninstall bigint
    );

SELECT
    is(
        (SELECT count(*) FROM perf_metrics),
        (
            SELECT 3 * count(*)
            FROM (
                SELECT app_id FROM public.apps WHERE owner_org = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
                UNION
                SELECT app_id FROM public.deleted_apps WHERE owner_org = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
            ) org_apps
        ),
        'metrics cover every org app for every day of the range'
    );

SELECT
    is(
        (SELECT count(*) FROM perf_metrics GROUP BY app_id, date ORDER BY 1 DESC LIMIT 1),
        1::bigint,
        'metrics have exactly one row per app and day'
    );

SELECT
    is(
        (SELECT ARRAY[mau, get, fail, install, uninstall] FROM perf_metrics WHERE app_id = 'com.demo.app' AND date = DATE '2023-03-02'),
        ARRAY[7, 7, 1, 7, 1]::bigint[],
        'daily_version is summed across versions for the day'
    );

SELECT
    is(
        (SELECT ARRAY[mau, get, fail, install, uninstall] FROM perf_metrics WHERE app_id = 'com.demo.app' AND date = DATE '2023-03-01'),
        ARRAY[0, 0, 0, 0, 0]::bigint[],
        'days without stats are zero-filled'
    );

SELECT
    is(
        (SELECT array_agg(date ORDER BY date) FROM perf_metrics WHERE app_id = 'com.demo.app'),
        ARRAY[DATE '2023-03-01', DATE '2023-03-02', DATE '2023-03-03'],
        'metrics are limited to the requested range'
    );

SELECT * FROM finish();

ROLLBACK;
