BEGIN;

SELECT plan(20);

-- Grants: authenticated callers only, never anonymous.
SELECT
    is(
        has_function_privilege('anon', 'public.get_update_daily_counts(character varying[], date, date)', 'EXECUTE'),
        false,
        'anonymous callers cannot read update counts'
    );

SELECT
    is(
        has_function_privilege('anon', 'public.acknowledge_compatibility_events(bigint[], text)', 'EXECUTE'),
        false,
        'anonymous callers cannot accept compatibility events'
    );

SELECT
    is(
        has_function_privilege('anon', 'public.get_channels_previous_deploys(character varying, bigint, bigint[], timestamptz[], integer)', 'EXECUTE'),
        false,
        'anonymous callers cannot read previous deployments'
    );

SELECT
    is(
        (
            SELECT bool_and(NOT p.prosecdef)
            FROM pg_proc AS p
            WHERE
                p.pronamespace = 'public'::regnamespace
                AND p.proname IN ('get_update_daily_counts', 'acknowledge_compatibility_events', 'get_channels_previous_deploys')
        ),
        true,
        'the new RPCs are security invoker (RLS of the caller applies)'
    );

-- Fixtures on the demo app: two bundles on one day, one on the next.
CREATE TEMP TABLE fanout_window AS
SELECT (current_date - 1) AS day_one, current_date AS day_two;
GRANT SELECT ON fanout_window TO authenticated;

DELETE FROM public.daily_version
WHERE app_id = 'com.demo.app' AND date IN ((SELECT day_one FROM fanout_window), (SELECT day_two FROM fanout_window));
INSERT INTO public.daily_version (date, app_id, version_name, install, fail, get)
VALUES
((SELECT day_one FROM fanout_window), 'com.demo.app', 'fanout-1', 3, 1, 10),
((SELECT day_one FROM fanout_window), 'com.demo.app', 'fanout-2', 4, NULL, 5),
((SELECT day_two FROM fanout_window), 'com.demo.app', 'fanout-1', 7, 2, 1);

INSERT INTO public.deploy_history (channel_id, app_id, version_id, created_by, owner_org, created_at, deployed_at)
SELECT
    1,
    'com.demo.app',
    v.id,
    '6aa76066-55ef-4238-ade6-0b32334a4097',
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    now() - (g || ' minutes')::interval,
    now() - (g || ' minutes')::interval
FROM generate_series(1, 4) AS g
CROSS JOIN LATERAL (SELECT id FROM public.app_versions WHERE app_id = 'com.demo.app' AND id <> 3 ORDER BY id LIMIT 1) AS v;

INSERT INTO public.compatibility_events (
    org_id, app_id, source, platform, channel_id, channel_name, current_version_name, previous_version_name
)
VALUES
('046a36ac-e03c-4590-9257-bd6c9dba9ee8', 'com.demo.app', 'default_channel_version_changed', 'ios', 990001, 'production', '2.0.0', '1.0.0'),
('046a36ac-e03c-4590-9257-bd6c9dba9ee8', 'com.demo.app', 'default_channel_version_changed', 'ios', 990002, 'production', '2.0.0', '1.0.0');

CREATE TEMP TABLE fanout_events AS
SELECT array_agg(id ORDER BY id) AS ids FROM public.compatibility_events WHERE channel_id IN (990001, 990002);
GRANT SELECT ON fanout_events TO authenticated;

SELECT tests.authenticate_as('test_user');

SELECT
    results_eq(
        $$
            SELECT date, install_count, fail_count, get_count
            FROM public.get_update_daily_counts(ARRAY['com.demo.app']::varchar[], (SELECT day_one FROM fanout_window), (SELECT day_two FROM fanout_window))
            ORDER BY date
        $$,
        $$
            SELECT date, coalesce(sum(install), 0)::bigint, coalesce(sum(fail), 0)::bigint, coalesce(sum(get), 0)::bigint
            FROM public.daily_version
            WHERE app_id = 'com.demo.app' AND date BETWEEN (SELECT day_one FROM fanout_window) AND (SELECT day_two FROM fanout_window)
            GROUP BY date
            ORDER BY date
        $$,
        'update counts are the per-day sums of daily_version'
    );

SELECT
    is(
        (
            SELECT install_count
            FROM public.get_update_daily_counts(ARRAY['com.demo.app']::varchar[], (SELECT day_one FROM fanout_window), (SELECT day_one FROM fanout_window))
        ),
        (
            SELECT sum(install)::bigint FROM public.daily_version
            WHERE app_id = 'com.demo.app' AND date = (SELECT day_one FROM fanout_window)
        ),
        'p_end is inclusive and one day sums every bundle of that day'
    );

SELECT
    throws_ok(
        $$SELECT * FROM public.get_update_daily_counts(ARRAY['com.demo.app']::varchar[], current_date - 400, current_date)$$,
        '22023',
        'invalid_window',
        'an update window longer than one billing cycle is refused'
    );

SELECT
    throws_ok(
        $$SELECT * FROM public.get_update_daily_counts((SELECT array_agg('app.' || g)::varchar[] FROM generate_series(1, 1001) g), current_date - 1, current_date)$$,
        '22023',
        'too_many_apps',
        'more than 1000 apps per update request is refused'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM public.get_channels_previous_deploys('com.demo.app', 3, ARRAY[1]::bigint[], ARRAY[NULL]::timestamptz[], 2)
        ),
        2::bigint,
        'previous deployments are capped per channel'
    );

SELECT
    results_eq(
        $$
            SELECT version_id, created_at
            FROM public.get_channels_previous_deploys('com.demo.app', 3, ARRAY[1]::bigint[], ARRAY[now() - interval '2 minutes']::timestamptz[], 20)
        $$,
        $$
            SELECT version_id, created_at
            FROM public.deploy_history
            WHERE app_id = 'com.demo.app' AND channel_id = 1 AND version_id <> 3 AND created_at < now() - interval '2 minutes'
            ORDER BY created_at DESC
            LIMIT 20
        $$,
        'previous deployments match the per-channel query, newest first, before the cutoff'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM public.get_channels_previous_deploys('com.demo.app', 3, ARRAY[1]::bigint[], ARRAY[now() - interval '2 minutes']::timestamptz[], 20)
            WHERE version_id = 3 OR created_at >= now() - interval '2 minutes'
        ),
        0::bigint,
        'the current bundle and deployments after the cutoff are excluded'
    );

SELECT
    throws_ok(
        $$SELECT * FROM public.get_channels_previous_deploys('com.demo.app', 3, ARRAY[1]::bigint[], NULL, 51)$$,
        '22023',
        'invalid_per_channel',
        'more than 50 deployments per channel is refused'
    );

SELECT
    throws_ok(
        $$SELECT * FROM public.get_channels_previous_deploys('com.demo.app', 3, ARRAY[1, 2]::bigint[], ARRAY[NULL]::timestamptz[], 5)$$,
        '22023',
        'invalid_cutoffs',
        'cutoffs must match the channels'
    );

SELECT
    throws_ok(
        $$SELECT public.acknowledge_compatibility_events((SELECT ids FROM fanout_events), '  ')$$,
        'reason_required',
        'a batch acknowledgement needs a reason'
    );

SELECT
    throws_ok(
        $$SELECT public.acknowledge_compatibility_events((SELECT array_agg(g)::bigint[] FROM generate_series(1, 501) g), 'bulk')$$,
        '22023',
        'too_many_events',
        'more than 500 events per batch is refused'
    );

SELECT
    lives_ok(
        $$SELECT public.acknowledge_compatibility_events((SELECT ids FROM fanout_events), 'accepted in bulk')$$,
        'a release manager accepts several events in one call'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM public.compatibility_events
            WHERE
                id = ANY((SELECT ids FROM fanout_events)::bigint[])
                AND resolution_kind = 'accepted'
                AND resolution_note = 'accepted in bulk'
                AND resolved_by = '6aa76066-55ef-4238-ade6-0b32334a4097'
        ),
        2::bigint,
        'every event of the batch is accepted with the reason and the caller'
    );

SELECT tests.clear_authentication();
SELECT tests.create_supabase_user('fanout_outsider', 'fanout-outsider@example.com');
SELECT tests.authenticate_as('fanout_outsider');

SELECT
    is(
        (
            SELECT count(*)
            FROM public.get_update_daily_counts(ARRAY['com.demo.app']::varchar[], (SELECT day_one FROM fanout_window), (SELECT day_two FROM fanout_window))
        ),
        0::bigint,
        'a user outside the organization counts no updates (RLS still applies)'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM public.get_channels_previous_deploys('com.demo.app', 3, ARRAY[1]::bigint[], NULL, 20)
        ),
        0::bigint,
        'a user outside the organization reads no deployments (RLS still applies)'
    );

SELECT
    throws_ok(
        $$SELECT public.acknowledge_compatibility_events(ARRAY[(SELECT ids[1] FROM fanout_events), 999999999]::bigint[], 'not mine')$$,
        'not_authorized',
        'a user outside the organization cannot accept events, and unknown ids fail the same way'
    );

SELECT * FROM finish();

ROLLBACK;
