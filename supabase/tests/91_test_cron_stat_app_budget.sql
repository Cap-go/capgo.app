BEGIN;

SELECT plan(2);

SELECT tests.authenticate_as_service_role();

SELECT ok(
    (
        SELECT count(*)::int
        FROM public.cron_tasks
        WHERE
            task_type = 'function_queue'::public.cron_task_type
            AND target LIKE '%"cron_stat_app"%'
    ) = 1
    AND (
        SELECT batch_size = 5 AND minute_interval = 1 AND enabled
        FROM public.cron_tasks
        WHERE
            name = 'stat_app_queue'
            AND task_type = 'function_queue'::public.cron_task_type
            AND target::jsonb = '["cron_stat_app"]'::jsonb
    ),
    'cron_stat_app is dispatched only by stat_app_queue at 5 apps per call'
);

SELECT ok(
    (
        SELECT target::jsonb = '["cron_sync_sub"]'::jsonb AND batch_size = 10
        FROM public.cron_tasks
        WHERE name = 'per_minute_queues'
    ),
    'per_minute_queues keeps cron_sync_sub at its batch size'
);

SELECT tests.clear_authentication();

SELECT * FROM finish(); -- noqa: AM04

ROLLBACK;
