BEGIN;

SELECT plan(12);

-- The 2FA guard is evaluated once per statement (InitPlan), not once per row.
SELECT
    is(
        (
            SELECT count(*)
            FROM pg_policies
            WHERE
                schemaname = 'public'
                AND policyname = 'Prevent non 2FA access'
                AND qual ILIKE '%SELECT verify_mfa()%'
        ),
        (
            SELECT count(*)
            FROM pg_policies
            WHERE schemaname = 'public' AND policyname = 'Prevent non 2FA access'
        ),
        'every Prevent non 2FA access policy wraps verify_mfa() in a scalar subquery'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM pg_policies
            WHERE
                schemaname = 'public'
                AND qual ILIKE '%verify_mfa()%'
                AND qual NOT ILIKE '%SELECT verify_mfa()%'
        ),
        0::bigint,
        'no policy calls verify_mfa() per row'
    );

SELECT
    is(
        has_function_privilege('anon', 'public.get_bundle_upload_daily_counts(character varying[], timestamptz, timestamptz)', 'EXECUTE'),
        false,
        'anonymous callers cannot read upload counts'
    );

SELECT
    is(
        has_function_privilege('anon', 'public.get_deploy_daily_counts(character varying[], timestamptz, timestamptz)', 'EXECUTE'),
        false,
        'anonymous callers cannot read deploy counts'
    );

-- Fixtures for a fresh two-day window on the demo app.
CREATE TEMP TABLE perf_window AS
SELECT date_trunc('day', now()) - interval '1 day' AS window_start, date_trunc('day', now()) + interval '1 day' AS window_end;
GRANT SELECT ON perf_window TO authenticated;

INSERT INTO public.app_versions (app_id, name, owner_org, user_id, created_at)
SELECT 'com.demo.app', 'perf-upload-' || g, '046a36ac-e03c-4590-9257-bd6c9dba9ee8', '6aa76066-55ef-4238-ade6-0b32334a4097', (SELECT window_start FROM perf_window) + interval '30 hours'
FROM generate_series(1, 3) g;
INSERT INTO public.deploy_history (channel_id, app_id, version_id, created_by, owner_org, deployed_at)
SELECT 1, 'com.demo.app', (SELECT id FROM public.app_versions WHERE name = 'perf-upload-1'), '6aa76066-55ef-4238-ade6-0b32334a4097', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', (SELECT window_start FROM perf_window) + interval '2 hours'
FROM generate_series(1, 2);

SELECT tests.authenticate_as('test_user');

SELECT
    is(
        (
            SELECT uploads
            FROM public.get_bundle_upload_daily_counts(ARRAY['com.demo.app']::varchar[], (SELECT window_start FROM perf_window), (SELECT window_end FROM perf_window))
            WHERE day_index = 1
        ),
        (
            SELECT count(*)
            FROM public.app_versions
            WHERE
                app_id = 'com.demo.app'
                AND created_at >= (SELECT window_start FROM perf_window) + interval '1 day'
                AND created_at < (SELECT window_end FROM perf_window)
                AND NOT (deleted AND coalesce(r2_path, '') = '' AND coalesce(external_url, '') = '' AND user_id IS NULL)
        ),
        'upload counts match the bundles of that day the member can read'
    );

CREATE TEMP TABLE perf_uploads_before AS
SELECT uploads
FROM public.get_bundle_upload_daily_counts(ARRAY['com.demo.app']::varchar[], (SELECT window_start FROM perf_window), (SELECT window_end FROM perf_window))
WHERE day_index = 1;

-- A system placeholder (builtin/unknown: deleted, no storage, no uploader) is not an upload.
RESET ROLE;
INSERT INTO public.app_versions (app_id, name, owner_org, deleted, created_at)
VALUES ('com.demo.app', 'perf-placeholder', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', true, (SELECT window_start FROM perf_window) + interval '30 hours');
SELECT tests.authenticate_as('test_user');

SELECT
    is(
        (
            SELECT uploads
            FROM public.get_bundle_upload_daily_counts(ARRAY['com.demo.app']::varchar[], (SELECT window_start FROM perf_window), (SELECT window_end FROM perf_window))
            WHERE day_index = 1
        ),
        (SELECT uploads FROM perf_uploads_before),
        'a system placeholder bundle is not counted as an upload'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM public.get_bundle_upload_daily_counts(ARRAY['com.demo.app']::varchar[], (SELECT window_start FROM perf_window), (SELECT window_end FROM perf_window))
            WHERE day_index NOT IN (0, 1)
        ),
        0::bigint,
        'no bucket falls outside the requested window'
    );

SELECT
    is(
        (
            SELECT deploys
            FROM public.get_deploy_daily_counts(ARRAY['com.demo.app']::varchar[], (SELECT window_start FROM perf_window), (SELECT window_end FROM perf_window))
            WHERE channel_id = 1 AND day_index = 0
        ),
        (
            SELECT count(*)
            FROM public.deploy_history
            WHERE
                app_id = 'com.demo.app'
                AND channel_id = 1
                AND deployed_at >= (SELECT window_start FROM perf_window)
                AND deployed_at < (SELECT window_start FROM perf_window) + interval '1 day'
        ),
        'deploy counts match the deployments of that day on the channel'
    );

SELECT
    is(
        (
            SELECT DISTINCT channel_name
            FROM public.get_deploy_daily_counts(ARRAY['com.demo.app']::varchar[], (SELECT window_start FROM perf_window), (SELECT window_end FROM perf_window))
            WHERE channel_id = 1
        ),
        (SELECT name FROM public.channels WHERE id = 1),
        'deploy counts carry the channel name'
    );

SELECT
    throws_ok(
        $$SELECT * FROM public.get_bundle_upload_daily_counts(ARRAY['com.demo.app']::varchar[], now() - interval '400 days', now())$$,
        '22023',
        'invalid_window',
        'a window longer than one billing cycle is refused'
    );

SELECT
    throws_ok(
        $$SELECT * FROM public.get_deploy_daily_counts((SELECT array_agg('app.' || g)::varchar[] FROM generate_series(1, 1001) g), now() - interval '1 day', now())$$,
        '22023',
        'too_many_apps',
        'more than 1000 apps per request is refused'
    );

SELECT tests.clear_authentication();
SELECT tests.create_supabase_user('perf_outsider', 'perf-outsider@example.com');
SELECT tests.authenticate_as('perf_outsider');

SELECT
    is(
        (
            SELECT count(*)
            FROM public.get_bundle_upload_daily_counts(ARRAY['com.demo.app']::varchar[], (SELECT window_start FROM perf_window), (SELECT window_end FROM perf_window))
        ),
        0::bigint,
        'a user outside the organization counts nothing (RLS still applies)'
    );

SELECT * FROM finish();

ROLLBACK;
