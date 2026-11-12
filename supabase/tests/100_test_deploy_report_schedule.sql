BEGIN;

SELECT set_config('request.jwt.claim.role', 'service_role', true);

SELECT plan(14);

SELECT ok(
    EXISTS (
        SELECT 1 FROM public.cron_tasks
        WHERE
            name = 'deploy_install_stats_email'
            AND enabled AND hour_interval = 1 AND run_at_minute = 0
            AND second_interval IS null AND minute_interval IS null
    ),
    'deploy reports have an executable hourly schedule'
);

CREATE TEMP TABLE report_context AS
SELECT
    gen_random_uuid() AS org_id,
    'com.test.deployreport.'
    || replace(gen_random_uuid()::text, '-', '') AS app_prefix;

SELECT tests.create_supabase_user(
    'deploy_report_user', 'deploy-report@example.com'
);

INSERT INTO public.users (id, email)
VALUES (
    tests.get_supabase_uid('deploy_report_user'), 'deploy-report@example.com'
);

INSERT INTO public.orgs (id, created_by, name, management_email)
SELECT
    org_id,
    tests.get_supabase_uid('deploy_report_user') AS created_by,
    'Deploy report tests' AS display_name,
    'deploy-report@example.com' AS management_email
FROM report_context;

CREATE TEMP TABLE report_cases (
    case_name text PRIMARY KEY,
    deploy_age interval,
    is_public boolean,
    ios boolean
);
INSERT INTO report_cases VALUES
('ready', interval '25 hours', true, true),
('fresh', interval '23 hours', true, true),
('stale', interval '49 hours', true, true),
('superseded', interval '26 hours', true, true),
('private', interval '25 hours', false, true),
('disabled', interval '25 hours', true, false),
('claimed', interval '25 hours', true, true),
('at24', interval '24 hours', true, true),
('at48', interval '48 hours', true, true),
('tie', interval '25 hours', true, true);

INSERT INTO public.apps (app_id, icon_url, owner_org, name)
SELECT
    ctx.app_prefix || '.' || rc.case_name AS app_id,
    '' AS icon_url,
    ctx.org_id,
    rc.case_name AS display_name
FROM report_context AS ctx CROSS JOIN report_cases AS rc;

INSERT INTO public.app_versions (app_id, name, owner_org)
SELECT
    ctx.app_prefix || '.' || rc.case_name AS app_id,
    '1.0.0' AS display_name,
    ctx.org_id
FROM report_context AS ctx CROSS JOIN report_cases AS rc;

INSERT INTO public.channels (
    app_id, name, version, public, ios, android, owner_org, created_by
)
SELECT
    a.app_id,
    'production' AS display_name,
    v.id,
    rc.is_public,
    rc.ios,
    false AS android,
    ctx.org_id,
    tests.get_supabase_uid('deploy_report_user') AS created_by
FROM report_context AS ctx CROSS JOIN report_cases AS rc
INNER JOIN public.apps AS a ON a.app_id = ctx.app_prefix || '.' || rc.case_name
INNER JOIN public.app_versions
    AS v ON a.app_id = v.app_id
AND v.name = '1.0.0';

-- Channel creation may record a deployment. Replace only our fixtures.
DELETE FROM public.deploy_history
WHERE owner_org = (SELECT ctx.org_id FROM report_context AS ctx);

INSERT INTO public.deploy_history (
    channel_id,
    app_id,
    version_id,
    deployed_at,
    owner_org,
    created_by,
    install_stats_email_sent_at
)
SELECT
    c.id,
    c.app_id,
    c.version,
    now() - rc.deploy_age AS deployed_at,
    ctx.org_id,
    tests.get_supabase_uid('deploy_report_user') AS created_by,
    CASE WHEN rc.case_name = 'claimed' THEN now() END
        AS install_stats_email_sent_at
FROM report_context AS ctx CROSS JOIN report_cases AS rc
INNER JOIN
    public.channels AS c
    ON c.app_id = ctx.app_prefix || '.' || rc.case_name;

INSERT INTO public.deploy_history (
    channel_id, app_id, version_id, deployed_at, owner_org, created_by
)
SELECT
    c.id,
    c.app_id,
    c.version,
    CASE
        WHEN rc.case_name = 'superseded' THEN now() - interval '1 hour' ELSE
            now() - rc.deploy_age
    END AS deployed_at,
    ctx.org_id,
    tests.get_supabase_uid('deploy_report_user') AS created_by
FROM report_context AS ctx CROSS JOIN report_cases AS rc
INNER JOIN
    public.channels AS c
    ON c.app_id = ctx.app_prefix || '.' || rc.case_name
WHERE rc.case_name IN ('superseded', 'tie');

SELECT lives_ok(
    'SELECT public.process_deploy_install_stats_email()',
    'producer runs against PostgreSQL'
);

CREATE TEMP VIEW report_messages AS
SELECT message -> 'payload' AS payload
FROM pgmq.q_cron_email
WHERE
    message -> 'payload' ->> 'orgId'
    = (SELECT ctx.org_id::text FROM report_context AS ctx);

SELECT is(
    (SELECT count(*) FROM report_messages), 3::bigint,
    'only eligible latest deployments are queued'
);
SELECT is((
    SELECT count(*) FROM report_messages
    WHERE payload ->> 'appId' LIKE '%.ready'
), 1::bigint, 'queues a 25-hour report');
SELECT is((
    SELECT count(*) FROM report_messages
    WHERE payload ->> 'appId' LIKE '%.at24'
), 1::bigint, '24-hour boundary is included');
SELECT is((
    SELECT count(*) FROM report_messages
    WHERE payload ->> 'appId' LIKE '%.at48'
), 0::bigint, '48-hour boundary is excluded');
SELECT is((
    SELECT count(*) FROM report_messages
    WHERE payload ->> 'appId' LIKE '%.superseded'
), 0::bigint, 'newer deployment blocks the previous report');
SELECT ok(
    (
        SELECT (payload ->> 'deployId')::bigint FROM report_messages
        WHERE payload ->> 'appId' LIKE '%.tie'
    )
    = (
        SELECT max(id) FROM public.deploy_history
        WHERE
            app_id
            = (SELECT ctx.app_prefix || '.tie' FROM report_context AS ctx)
    ),
    'equal deployment timestamps resolve deterministically to the newest id'
);
SELECT ok(
    (SELECT bool_and(
        payload ->> 'type' = 'deploy_install_stats'
        AND payload ->> 'versionName' = '1.0.0'
        AND payload ->> 'channelName' = 'production'
        AND payload ->> 'platform' = 'ios'
        AND payload ->> 'email' = 'deploy-report@example.com'
    ) FROM report_messages),
    'queue payload preserves the worker contract'
);

SELECT public.process_deploy_install_stats_email();
SELECT is(
    (SELECT count(*) FROM report_messages), 3::bigint,
    'a second run does not duplicate claimed reports'
);

UPDATE public.deploy_history SET install_stats_email_sent_at = null
WHERE app_id = (SELECT ctx.app_prefix || '.ready' FROM report_context AS ctx);
SELECT public.process_deploy_install_stats_email();
SELECT is((
    SELECT count(*) FROM report_messages
    WHERE payload ->> 'appId' LIKE '%.ready'
), 2::bigint, 'worker-released claims can retry inside 48 hours');

-- A burst larger than the per-run cap must continue in the next run.
INSERT INTO public.apps (app_id, icon_url, owner_org, name)
SELECT
    ctx.app_prefix || '.burst' || n AS app_id,
    '' AS icon_url,
    ctx.org_id,
    'burst' AS display_name
FROM report_context AS ctx CROSS JOIN generate_series(1, 501) AS n;
INSERT INTO public.app_versions (app_id, name, owner_org)
SELECT
    app_id,
    '1.0.0' AS display_name,
    owner_org
FROM public.apps
WHERE
    owner_org = (SELECT ctx.org_id FROM report_context AS ctx)
    AND name = 'burst';
INSERT INTO public.channels (
    app_id, name, version, public, ios, android, owner_org, created_by
)
SELECT
    v.app_id,
    'production' AS display_name,
    v.id,
    true AS public_channel,
    true AS ios,
    false AS android,
    v.owner_org,
    tests.get_supabase_uid('deploy_report_user') AS created_by
FROM public.app_versions AS v
WHERE
    v.owner_org = (SELECT ctx.org_id FROM report_context AS ctx)
    AND v.app_id LIKE '%.burst%';
DELETE FROM public.deploy_history
WHERE
    owner_org = (SELECT ctx.org_id FROM report_context AS ctx)
    AND app_id LIKE '%.burst%';
INSERT INTO public.deploy_history (
    channel_id, app_id, version_id, deployed_at, owner_org, created_by
)
SELECT
    id,
    app_id,
    version,
    now() - interval '30 hours' AS deployed_at,
    owner_org,
    tests.get_supabase_uid('deploy_report_user') AS created_by
FROM public.channels
WHERE
    owner_org = (SELECT ctx.org_id FROM report_context AS ctx)
    AND app_id LIKE '%.burst%';

SELECT public.process_deploy_install_stats_email();
SELECT is((
    SELECT count(*) FROM report_messages
    WHERE payload ->> 'appId' LIKE '%.burst%'
), 500::bigint, 'a single run claims at most 500 reports');
SELECT public.process_deploy_install_stats_email();
SELECT is((
    SELECT count(*) FROM report_messages
    WHERE payload ->> 'appId' LIKE '%.burst%'
), 501::bigint, 'next run drains the remaining report');
SELECT is(
    (
        SELECT count(*)
        FROM public.deploy_history
        WHERE
            owner_org = (SELECT ctx.org_id FROM report_context AS ctx)
            AND app_id LIKE '%.burst%'
            AND install_stats_email_sent_at IS NOT null
    ),
    501::bigint,
    'all queued burst reports have claims'
);

SELECT * FROM finish(); -- noqa: AM04
ROLLBACK;
