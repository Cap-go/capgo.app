BEGIN;

SELECT set_config('request.jwt.claim.role', 'service_role', true);

SELECT plan(4);

-- Parallel safe: scope queue assertions to wake_context, never delete q_cron_email.

CREATE TEMP VIEW cron_email_dispatch_requests AS
SELECT count(*) AS requests
FROM net.http_request_queue
WHERE
    pg_catalog.convert_from(body, 'utf8')::jsonb ->> 'queue_name' = 'cron_email';

CREATE TEMP TABLE dispatch_baseline AS
SELECT requests FROM cron_email_dispatch_requests;

SELECT public.process_deploy_install_stats_email();

SELECT is(
    (SELECT requests FROM cron_email_dispatch_requests)
    - (SELECT requests FROM dispatch_baseline),
    0::bigint,
    'empty producer run does not wake cron_email'
);

CREATE TEMP TABLE wake_context (
    org_id uuid PRIMARY KEY,
    app_id text NOT NULL
);

INSERT INTO wake_context
SELECT gen_random_uuid(), 'com.test.deploywake.' || replace(gen_random_uuid()::text, '-', '');

SELECT tests.create_supabase_user(
    'deploy_wake_user', 'deploy-wake@example.com'
);

INSERT INTO public.users (id, email)
VALUES (
    tests.get_supabase_uid('deploy_wake_user'), 'deploy-wake@example.com'
);

INSERT INTO public.orgs (id, created_by, name, management_email)
SELECT
    org_id,
    tests.get_supabase_uid('deploy_wake_user'),
    'Deploy wake tests',
    'deploy-wake@example.com'
FROM wake_context;

INSERT INTO public.apps (app_id, icon_url, owner_org, name)
SELECT app_id, '', org_id, 'wake' FROM wake_context;

WITH version_row AS (
    INSERT INTO public.app_versions (app_id, name, owner_org)
    SELECT app_id, '1.0.0', org_id FROM wake_context
    RETURNING id, app_id, owner_org
)
INSERT INTO public.channels (
    app_id, name, version, public, ios, android, owner_org, created_by
)
SELECT
    v.app_id,
    'production',
    v.id,
    true,
    true,
    false,
    v.owner_org,
    tests.get_supabase_uid('deploy_wake_user')
FROM version_row AS v;

INSERT INTO public.deploy_history (
    channel_id, app_id, version_id, deployed_at, owner_org, created_by
)
SELECT
    c.id,
    c.app_id,
    c.version,
    now() - interval '25 hours',
    c.owner_org,
    tests.get_supabase_uid('deploy_wake_user')
FROM public.channels AS c
INNER JOIN wake_context AS ctx ON c.app_id = ctx.app_id;

TRUNCATE dispatch_baseline;
INSERT INTO dispatch_baseline SELECT requests FROM cron_email_dispatch_requests;

SELECT public.process_deploy_install_stats_email();

SELECT is(
    (SELECT count(*) FROM pgmq.q_cron_email
     WHERE message -> 'payload' ->> 'type' = 'deploy_install_stats_v2'
       AND message -> 'payload' ->> 'appId' = (SELECT app_id FROM wake_context)),
    1::bigint,
    'producer queues one deploy report'
);

SELECT ok(
    (SELECT requests FROM cron_email_dispatch_requests)
    > (SELECT requests FROM dispatch_baseline),
    'producer wakes cron_email after sending'
);

TRUNCATE dispatch_baseline;
INSERT INTO dispatch_baseline SELECT requests FROM cron_email_dispatch_requests;

SELECT public.process_deploy_install_stats_email();

SELECT is(
    (SELECT requests FROM cron_email_dispatch_requests)
    - (SELECT requests FROM dispatch_baseline),
    0::bigint,
    'second run without new sends does not wake again'
);

SELECT * FROM finish();

ROLLBACK;
