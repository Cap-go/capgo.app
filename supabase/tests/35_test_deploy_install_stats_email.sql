BEGIN;

SELECT plan(6);

DO $$
BEGIN
  PERFORM tests.create_supabase_user('deploy_stats_user', 'deploy-stats@example.com', '555-000-0000');
END;
$$ LANGUAGE plpgsql;

CREATE TEMP TABLE deploy_stats_context (
    user_id uuid,
    org_id uuid,
    app_id text,
    ios_version_id bigint,
    android_version_id bigint,
    ios_channel_id bigint,
    android_channel_id bigint,
    private_channel_id bigint,
    ios_deploy_id bigint,
    android_deploy_id bigint,
    private_deploy_id bigint
) ON COMMIT DROP;

WITH user_insert AS (
    INSERT INTO public.users (id, email, created_at, updated_at)
    VALUES (
        tests.get_supabase_uid('deploy_stats_user'),
        'deploy-stats@example.com',
        now(),
        now()
    )
    RETURNING id
)

INSERT INTO deploy_stats_context (user_id, org_id, app_id)
SELECT
    user_insert.id,
    gen_random_uuid(),
    'com.deploystats.app'
FROM user_insert;

INSERT INTO public.orgs (id, created_by, name, management_email)
SELECT
    org_id,
    user_id,
    'Deploy Stats Org',
    'deploy-stats@example.com'
FROM deploy_stats_context;

INSERT INTO public.apps (
    app_id, icon_url, owner_org, name, retention, default_upload_channel
)
SELECT
    app_id,
    '',
    org_id,
    'Deploy Stats App',
    2592000,
    'production'
FROM deploy_stats_context;

WITH ios_version AS (
    INSERT INTO public.app_versions (app_id, name, owner_org)
    SELECT
        app_id,
        '1.0.0-ios',
        org_id
    FROM deploy_stats_context
    RETURNING id
),

android_version AS (
    INSERT INTO public.app_versions (app_id, name, owner_org)
    SELECT
        app_id,
        '1.0.0-android',
        org_id
    FROM deploy_stats_context
    RETURNING id
)

UPDATE deploy_stats_context
SET
    ios_version_id = (SELECT id FROM ios_version),
    android_version_id = (SELECT id FROM android_version);

WITH ios_channel AS (
    INSERT INTO public.channels (
        created_by, app_id, name, version, public, ios, android, electron, owner_org
    )
    SELECT
        user_id,
        app_id,
        'prod-ios',
        ios_version_id,
        true,
        true,
        false,
        false,
        org_id
    FROM deploy_stats_context
    RETURNING id
),

android_channel AS (
    INSERT INTO public.channels (
        created_by, app_id, name, version, public, ios, android, electron, owner_org
    )
    SELECT
        user_id,
        app_id,
        'prod-android',
        android_version_id,
        true,
        false,
        true,
        false,
        org_id
    FROM deploy_stats_context
    RETURNING id
),

private_channel AS (
    INSERT INTO public.channels (
        created_by, app_id, name, version, public, ios, android, electron, owner_org
    )
    SELECT
        user_id,
        app_id,
        'private-beta',
        ios_version_id,
        false,
        true,
        false,
        false,
        org_id
    FROM deploy_stats_context
    RETURNING id
)

UPDATE deploy_stats_context
SET
    ios_channel_id = (SELECT id FROM ios_channel),
    android_channel_id = (SELECT id FROM android_channel),
    private_channel_id = (SELECT id FROM private_channel);

WITH ios_deploy AS (
    INSERT INTO public.deploy_history (
        channel_id,
        app_id,
        version_id,
        deployed_at,
        created_by,
        owner_org
    )
    SELECT
        ios_channel_id,
        app_id,
        ios_version_id,
        now() - interval '25 hours',
        user_id,
        org_id
    FROM deploy_stats_context
    RETURNING id
),

android_deploy AS (
    INSERT INTO public.deploy_history (
        channel_id,
        app_id,
        version_id,
        deployed_at,
        created_by,
        owner_org
    )
    SELECT
        android_channel_id,
        app_id,
        android_version_id,
        now() - interval '25 hours',
        user_id,
        org_id
    FROM deploy_stats_context
    RETURNING id
),

private_deploy AS (
    INSERT INTO public.deploy_history (
        channel_id,
        app_id,
        version_id,
        deployed_at,
        created_by,
        owner_org
    )
    SELECT
        private_channel_id,
        app_id,
        ios_version_id,
        now() - interval '25 hours',
        user_id,
        org_id
    FROM deploy_stats_context
    RETURNING id
)

UPDATE deploy_stats_context
SET
    ios_deploy_id = (SELECT id FROM ios_deploy),
    android_deploy_id = (SELECT id FROM android_deploy),
    private_deploy_id = (SELECT id FROM private_deploy);

DELETE FROM pgmq.q_cron_email
WHERE
    message -> 'payload' ->> 'appId' = (SELECT app_id FROM deploy_stats_context)
    AND message -> 'payload' ->> 'type' = 'deploy_install_stats_v2';

SELECT
    ok(
        pg_get_functiondef(
            'process_deploy_install_stats_email()'::regprocedure
        ) IS NOT null,
        'process_deploy_install_stats_email function exists'
    );

SELECT public.process_deploy_install_stats_email();

SELECT
    is(
        (
            SELECT count(*)
            FROM pgmq.q_cron_email
            WHERE
                message -> 'payload' ->> 'appId'
                = (SELECT app_id FROM deploy_stats_context)
                AND message -> 'payload' ->> 'type' = 'deploy_install_stats_v2'
        ),
        2::bigint,
        'queues one message per platform default channel'
    );

SELECT
    ok(
        (
            SELECT install_stats_email_sent_at IS NOT null
            FROM public.deploy_history
            WHERE id = (SELECT ios_deploy_id FROM deploy_stats_context)
        ),
        'claims ios deploy for reporting'
    );

SELECT
    ok(
        (
            SELECT install_stats_email_sent_at IS NOT null
            FROM public.deploy_history
            WHERE id = (SELECT android_deploy_id FROM deploy_stats_context)
        ),
        'claims android deploy for reporting'
    );

SELECT
    ok(
        (
            SELECT install_stats_email_sent_at IS null
            FROM public.deploy_history
            WHERE id = (SELECT private_deploy_id FROM deploy_stats_context)
        ),
        'skips private channel deploy'
    );

SELECT public.process_deploy_install_stats_email();

SELECT
    is(
        (
            SELECT count(*)
            FROM pgmq.q_cron_email
            WHERE
                message -> 'payload' ->> 'appId'
                = (SELECT app_id FROM deploy_stats_context)
                AND message -> 'payload' ->> 'type' = 'deploy_install_stats_v2'
        ),
        2::bigint,
        'does not queue duplicates after resend'
    );

SELECT * FROM finish();

ROLLBACK;
