-- An enabled task with no interval never runs. Restore its hourly schedule.
UPDATE public.cron_tasks
SET hour_interval = 1, run_at_minute = 0, updated_at = now()
WHERE
    name = 'deploy_install_stats_email'
    AND second_interval IS NULL
    AND minute_interval IS NULL
    AND hour_interval IS NULL
    AND run_at_hour IS NULL;

CREATE OR REPLACE FUNCTION public.process_deploy_install_stats_email()
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    report RECORD;
BEGIN
    FOR report IN
        WITH latest AS MATERIALIZED (
            SELECT DISTINCT ON (dh.app_id, channel_platform)
                dh.id,
                dh.app_id,
                dh.deployed_at,
                CASE
                    WHEN c.ios AND NOT c.android THEN 'ios'
                    WHEN c.android AND NOT c.ios THEN 'android'
                    ELSE 'all'
                END AS channel_platform
            FROM public.deploy_history dh
            JOIN public.channels c ON c.id = dh.channel_id
            -- Match the worker's retry window and avoid replaying historical mail.
            -- deployed_at is indexed: never scan all deployment history each hour.
            WHERE dh.deployed_at > now() - interval '48 hours'
                AND c.public
                AND (c.ios OR c.android)
            ORDER BY dh.app_id, channel_platform, dh.deployed_at DESC, dh.id DESC
        ),
        eligible AS MATERIALIZED (
            SELECT dh.id, l.channel_platform
            FROM latest l
            JOIN public.deploy_history dh ON dh.id = l.id
            JOIN public.orgs o ON o.id = dh.owner_org
            WHERE l.deployed_at <= now() - interval '24 hours'
                AND dh.install_stats_email_sent_at IS NULL
                AND nullif(o.management_email, '') IS NOT NULL
            ORDER BY l.deployed_at, dh.id
            LIMIT 500
            FOR UPDATE OF dh SKIP LOCKED
        ),
        claimed AS (
            UPDATE public.deploy_history dh
            SET install_stats_email_sent_at = now()
            FROM eligible e
            WHERE dh.id = e.id
            RETURNING dh.*
        )
        SELECT
            dh.id, dh.app_id, dh.version_id, dh.deployed_at, dh.owner_org,
            dh.channel_id, e.channel_platform, o.management_email,
            c.name AS channel_name, v.name AS version_name, a.name AS app_name
        FROM claimed dh
        JOIN eligible e ON e.id = dh.id
        JOIN public.orgs o ON o.id = dh.owner_org
        JOIN public.channels c ON c.id = dh.channel_id
        JOIN public.app_versions v ON v.id = dh.version_id
        JOIN public.apps a ON a.app_id = dh.app_id
    LOOP
        PERFORM pgmq.send('cron_email', jsonb_build_object(
            'function_name', 'cron_email',
            'function_type', 'cloudflare',
            'payload', jsonb_build_object(
                'email', report.management_email,
                'orgId', report.owner_org,
                'appId', report.app_id,
                'type', 'deploy_install_stats',
                'deployId', report.id,
                'versionId', report.version_id,
                'versionName', report.version_name,
                'channelId', report.channel_id,
                'channelName', report.channel_name,
                'platform', report.channel_platform,
                'appName', report.app_name,
                'deployedAt', report.deployed_at
            )
        ));
    END LOOP;
END;
$$;
