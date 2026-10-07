-- Cron 'queue' ticks carry no data: an identical unread tick must not be
-- enqueued twice, otherwise a one-message-per-tick drain can never catch up
-- after a failed run and the backlog grows forever.
BEGIN;

SELECT plan(9);

SELECT pgmq.purge_queue('cron_app_fame');

SELECT
    public.enqueue_cron_tick(
        'cron_app_fame',
        '{"function_name":"cron_app_fame","function_type":"cloudflare"}'::jsonb
    );
SELECT
    public.enqueue_cron_tick(
        'cron_app_fame',
        '{"function_name":"cron_app_fame","function_type":"cloudflare"}'::jsonb
    );

SELECT
    is(
        (SELECT count(*)::int FROM pgmq.q_cron_app_fame),
        1,
        'an identical unread tick is not enqueued twice'
    );

-- A different payload is a different message and still goes through.
SELECT
    public.enqueue_cron_tick(
        'cron_app_fame', '{"function_name":"cron_app_fame"}'::jsonb
    );

SELECT
    is(
        (SELECT count(*)::int FROM pgmq.q_cron_app_fame),
        2,
        'a tick with a different payload is enqueued'
    );

-- Once the pending ticks are read (in flight or retrying), the next tick is
-- enqueued so a slow or failing run still gets a fresh tick afterwards.
SELECT count(*) FROM pgmq.read('cron_app_fame', 120, 10);

SELECT
    public.enqueue_cron_tick(
        'cron_app_fame',
        '{"function_name":"cron_app_fame","function_type":"cloudflare"}'::jsonb
    );

SELECT
    is(
        (
            SELECT count(*)::int FROM pgmq.q_cron_app_fame
            WHERE read_ct = 0
        ),
        1,
        'a new tick is enqueued once the previous one has been read'
    );

-- process_all_cron_tasks routes 'queue' tasks and the rollout tick through
-- the dedupe helper.
SELECT
    ok(
        pg_catalog.pg_get_functiondef(
            'public.process_all_cron_tasks()'::pg_catalog.regprocedure
        ) LIKE '%public.enqueue_cron_tick(%task.target%',
        'process_all_cron_tasks enqueues queue tasks through enqueue_cron_tick'
    );

SELECT
    ok(
        pg_catalog.pg_get_functiondef(
            'public.process_all_cron_tasks()'::pg_catalog.regprocedure
        ) LIKE '%public.enqueue_cron_tick(%''cron_rollout_auto_pause''%',
        'process_all_cron_tasks enqueues the rollout tick through enqueue_cron_tick'
    );

SELECT
    ok(
        pg_catalog.pg_get_functiondef(
            'public.process_all_cron_tasks()'::pg_catalog.regprocedure
        ) NOT LIKE '%pgmq.send(%',
        'process_all_cron_tasks no longer sends ticks with raw pgmq.send'
    );

SELECT
    ok(
        NOT pg_catalog.has_function_privilege(
            'authenticated', 'public.enqueue_cron_tick(text, jsonb)', 'EXECUTE'
        ),
        'authenticated cannot enqueue cron ticks'
    );

SELECT
    ok(
        NOT pg_catalog.has_function_privilege(
            'anon', 'public.enqueue_cron_tick(text, jsonb)', 'EXECUTE'
        ),
        'anon cannot enqueue cron ticks'
    );

SELECT
    ok(
        pg_catalog.has_function_privilege(
            'service_role', 'public.enqueue_cron_tick(text, jsonb)', 'EXECUTE'
        ),
        'service_role can enqueue cron ticks'
    );

SELECT * FROM finish();

ROLLBACK;
