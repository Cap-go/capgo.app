-- cron_app_fame waits on Workers AI (~20s per attempt): process_function_queue
-- must send one awaited consumer call whose pg_net timeout outlives the
-- consumer's 90s HTTP timeout, instead of the default 8s fire-and-forget calls.
BEGIN;

SELECT plan(4);

SELECT pgmq.send('cron_app_fame', '{"function_name":"cron_app_fame"}'::jsonb)
FROM generate_series(1, 3);

DELETE FROM net.http_request_queue;

SELECT public.process_function_queue('cron_app_fame', 1);

SELECT
    is(
        (SELECT count(*)::int FROM net.http_request_queue),
        1,
        'cron_app_fame sends a single consumer call even with a backlog'
    );

SELECT
    is(
        (SELECT timeout_milliseconds FROM net.http_request_queue),
        100000,
        'cron_app_fame pg_net call outlives the 90s consumer timeout'
    );

SELECT
    is(
        (
            SELECT convert_from(body, 'UTF8')::jsonb ->> 'wait_for_completion'
            FROM net.http_request_queue
        ),
        'true',
        'cron_app_fame consumer call waits for completion'
    );

-- Other queues keep the short fire-and-forget call.
DELETE FROM net.http_request_queue;
SELECT pgmq.send('cron_email', '{"function_name":"cron_email"}'::jsonb);
SELECT public.process_function_queue('cron_email', 950);

SELECT
    is(
        (SELECT timeout_milliseconds FROM net.http_request_queue),
        8000,
        'default queues keep the 8s fire-and-forget pg_net timeout'
    );

SELECT * FROM finish();

ROLLBACK;
