-- Hourly deploy report producer enqueues into cron_email but that queue is only
-- polled by low_frequency_queues every 2 hours. Wake the consumer when we send.
CREATE OR REPLACE FUNCTION public.process_deploy_install_stats_email()
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    report RECORD;
    v_sent integer := 0;
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
            dh.channel_id, dh.install_stats_email_sent_at, e.channel_platform, o.management_email,
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
                'type', 'deploy_install_stats_v2',
                'deployId', report.id,
                'reportClaimedAt', report.install_stats_email_sent_at,
                'versionId', report.version_id,
                'versionName', report.version_name,
                'channelId', report.channel_id,
                'channelName', report.channel_name,
                'platform', report.channel_platform,
                'appName', report.app_name,
                'deployedAt', report.deployed_at
            )
        ));
        v_sent := v_sent + 1;
    END LOOP;

    IF v_sent > 0 THEN
        -- Same dispatch path as function_queue cron tasks (http_dispatch_post).
        BEGIN
            PERFORM public.process_function_queue('cron_email');
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'deploy install stats wake failed: %', SQLERRM;
        END;
    END IF;
END;
$$;
