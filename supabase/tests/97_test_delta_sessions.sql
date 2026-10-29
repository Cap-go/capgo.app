BEGIN;
SELECT extensions.plan(22);

CREATE TEMP TABLE session_apps ON COMMIT DROP AS
SELECT
    a.owner_org,
    a.user_id,
    'com.test.delta.sessions.' || n AS app_id
FROM public.apps AS a CROSS JOIN pg_catalog.generate_series(1, 2) AS n
WHERE a.app_id = 'com.demo.app';
INSERT INTO public.apps (app_id, owner_org, user_id, name, icon_url)
SELECT
    app_id,
    owner_org,
    user_id,
    'Delta sessions test' AS fixture_name,
    '' AS icon_url
FROM session_apps;

CREATE TEMP TABLE session_expected ON COMMIT DROP AS
SELECT
    e.id,
    e.app_id,
    e.file_name,
    e.session_hex,
    'orgs/' || a.owner_org || '/apps/' || e.app_id || '/delta/'
    || CASE WHEN e.session_hex IS NULL THEN '' ELSE e.session_hex || '/' END
    || pg_catalog.repeat('ab', 32) || '_' || e.file_name AS s3_path
FROM (
    VALUES
    (
        -970006::bigint,
        'com.test.delta.sessions.1',
        'a.js',
        pg_catalog.repeat('54', 370)
    ),
    (
        -970005::bigint,
        'com.test.delta.sessions.1',
        'b.js',
        pg_catalog.repeat('54', 370)
    ),
    (
        -970004::bigint,
        'com.test.delta.sessions.2',
        'c.js',
        pg_catalog.repeat('54', 370)
    ),
    (-970003::bigint, 'com.test.delta.sessions.1', 'd.js', NULL),
    (-970002::bigint, 'com.test.delta.sessions.1', 'e.js', '56'),
    (-970001::bigint, 'com.test.delta.sessions.1', 'f.js', NULL)
) AS e (id, app_id, file_name, session_hex)
INNER JOIN session_apps AS a ON e.app_id = a.app_id;
INSERT INTO public.delta_files (
    id, app_id, s3_path, file_name, file_hash, file_size,
    path_key, entry_key, path_org, path_session, path_sha
)
SELECT
    e.id,
    e.app_id,
    '' AS s3_path,
    e.file_name,
    '' AS file_hash,
    1 AS file_size,
    public.delta_path_key(e.s3_path) AS path_key,
    public.delta_entry_key(
        e.s3_path, e.file_name, pg_catalog.repeat('cd', 32)
    ) AS entry_key,
    a.owner_org,
    pg_catalog.decode(e.session_hex, 'hex') AS path_session,
    pg_catalog.decode(pg_catalog.repeat('ab', 32), 'hex') AS path_sha
FROM session_expected AS e INNER JOIN session_apps AS a ON e.app_id = a.app_id;
INSERT INTO public.app_versions (id, app_id, name, owner_org, storage_provider)
SELECT
    -970001 AS id,
    app_id,
    'pgtap-delta-sessions' AS fixture_name,
    owner_org,
    'r2' AS storage_provider
FROM session_apps
WHERE app_id = 'com.test.delta.sessions.1';
INSERT INTO public.version_files (app_version_id, file_ids)
SELECT
    -970001 AS app_version_id,
    pg_catalog.array_agg(id ORDER BY id) AS file_ids
FROM session_expected
WHERE app_id = 'com.test.delta.sessions.1';

SELECT extensions.is(
    public.delta_sessions_move(2),
    0,
    'session moves wait for the rollout switch'
);
SELECT extensions.is(
    (SELECT count(*)::integer FROM public.delta_sessions),
    0,
    'disabled moves create no sessions'
);
SELECT vault.create_secret('true', 'CAPGO_DELTA_SESSIONS_ENABLED');
INSERT INTO public.backfill_progress (
    job_name, scope_key, cutover_at, last_processed_id
)
VALUES ('delta_sessions_move', 'all', now(), -970007)
ON CONFLICT (job_name, scope_key) DO UPDATE
    SET last_processed_id = excluded.last_processed_id;

SELECT extensions.is(
    public.delta_sessions_move(2),
    2,
    'first bounded batch moves two rows'
);
SELECT extensions.is(
    (SELECT count(*)::integer FROM public.delta_sessions),
    1,
    'files in one upload share a single session'
);
SELECT extensions.is((
    SELECT count(*)::integer FROM public.delta_files
    WHERE
        id IN (-970006, -970005)
        AND path_session IS NULL
        AND path_session_id IS NOT NULL
), 2, 'wide inline sessions become integer references');
SELECT extensions.is((
    SELECT last_processed_id FROM public.backfill_progress
    WHERE job_name = 'delta_sessions_move'
), -970005::bigint, 'progress commits at the last scanned id');
SELECT extensions.is(
    public.delta_sessions_move(2),
    1,
    'next batch skips a sessionless row'
);
SELECT extensions.is(
    public.delta_sessions_move(2),
    1,
    'later batch resumes past sessionless rows'
);
SELECT extensions.is(
    (SELECT count(*)::integer FROM public.delta_sessions),
    3,
    'session identity includes its app'
);
SELECT extensions.is(
    public.delta_sessions_attach(
        ARRAY[-970006, -970005, -970004, -970003, -970002, -970001]::bigint[]
    ),
    0,
    'repeating an attachment is idempotent'
);
SELECT extensions.results_eq(
    $$SELECT s3_path::text FROM public.version_manifest
      WHERE app_version_id = -970001 ORDER BY id$$,
    $$SELECT s3_path FROM session_expected
      WHERE app_id = 'com.test.delta.sessions.1' ORDER BY id$$,
    'version_manifest rebuilds every original path'
);
SELECT extensions.results_eq(
    $$SELECT s3_path::text FROM public.manifest
      WHERE app_version_id = -970001 ORDER BY id$$,
    $$SELECT s3_path FROM session_expected
      WHERE app_id = 'com.test.delta.sessions.1' ORDER BY id$$,
    'the published CLI compatibility view rebuilds every original path'
);
SELECT extensions.ok((
    SELECT bool_and(public.delta_version_has_entry(-970001, s3_path, ''))
    FROM session_expected
    WHERE app_id = 'com.test.delta.sessions.1'
), 'entry validation resolves shared sessions');
SELECT extensions.ok(
    NOT pg_catalog.has_function_privilege(
        'anon', 'public.delta_sessions_attach(bigint[])', 'EXECUTE'
    ),
    'anonymous callers cannot attach sessions'
);
SELECT extensions.ok(
    NOT pg_catalog.has_function_privilege(
        'authenticated', 'public.delta_sessions_move(integer)', 'EXECUTE'
    ),
    'users cannot run the backfill'
);
SELECT extensions.ok(
    pg_catalog.has_function_privilege(
        'service_role', 'public.delta_sessions_move(integer)', 'EXECUTE'
    ),
    'internal workers can run the backfill'
);
SELECT extensions.ok(NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    INNER JOIN pg_catalog.pg_namespace AS n ON p.pronamespace = n.oid
    WHERE
        n.nspname = 'pganalyze'
        AND p.proname IN ('get_column_stats', 'get_relation_stats_ext')
        AND NOT coalesce(p.proconfig @> ARRAY['search_path=""'], FALSE)
), 'collector helpers have fixed empty search paths when installed');

SET LOCAL ROLE anon;
SELECT set_config('request.headers', '{}', TRUE);
SELECT extensions.is(
    (SELECT count(*)::integer FROM public.delta_sessions),
    0,
    'unauthenticated callers see no sessions'
);
SELECT set_config(
    'request.headers',
    '{"capgkey":"invalid-delta-session-test-key"}',
    TRUE
);
SELECT extensions.is(
    (SELECT count(*)::integer FROM public.delta_sessions),
    0,
    'invalid API keys see no sessions'
);
RESET ROLE;
SELECT set_config('request.headers', '{}', TRUE);
SET LOCAL ROLE authenticated;
SELECT set_config(
    'request.jwt.claims',
    '{"sub":"c591b04e-cf29-4945-b9a0-776d0672061a",'
    '"role":"authenticated","aal":"aal2"}',
    TRUE
);
SELECT extensions.is((
    SELECT count(*)::integer FROM public.delta_sessions
    WHERE app_id LIKE 'com.test.delta.sessions.%'
), 3, 'the org owner reads its sessions');
RESET ROLE;
SELECT set_config('request.jwt.claims', '', TRUE);

DELETE FROM public.apps
WHERE app_id = 'com.test.delta.sessions.2';
SELECT extensions.is((
    SELECT count(*)::integer FROM public.delta_sessions
    WHERE app_id = 'com.test.delta.sessions.2'
), 0, 'app deletion removes its sessions');
SELECT extensions.is((
    SELECT count(*)::integer FROM public.delta_sessions
    WHERE app_id = 'com.test.delta.sessions.1'
), 2, 'app deletion preserves other apps sessions');
SELECT extensions.finish();
ROLLBACK;
