BEGIN;

SELECT plan(8);

SELECT pgmq.create('test_http_dispatch');

CREATE TEMP VIEW test_outbox AS
SELECT calls, timeout_ms, body
FROM public.http_dispatch_outbox
WHERE target = 'test_http_dispatch';

SELECT ok(
  NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')
  AND to_regclass('public.http_dispatch_targets') IS NULL,
  'pg_net and the routing switch are gone: wakeups only use the outbox'
);

-- One consumer call per 100 readable messages, in a single outbox row.
SELECT pgmq.send_batch(
  'test_http_dispatch',
  ARRAY(SELECT '{"function_name":"noop"}'::jsonb FROM generate_series(1, 150))
);

SELECT public.process_function_queue('test_http_dispatch', 100);

SELECT results_eq(
  'SELECT calls, timeout_ms, body FROM test_outbox',
  $$VALUES (2, 8000, '{"queue_name":"test_http_dispatch","batch_size":100,"wait_for_completion":false}'::jsonb)$$,
  'a queue wakeup writes one outbox row with the consumer call count'
);

SELECT ok(
  (SELECT url FROM public.http_dispatch_outbox WHERE target = 'test_http_dispatch')
  LIKE '%/functions/v1/triggers/queue_consumer/sync',
  'outbox rows keep the consumer URL'
);

-- Wakeups are appended, never upserted: business transactions that wake the
-- cache purge must not wait on each other's uncommitted row. The dispatcher
-- coalesces identical rows after claiming them.
SELECT public.http_dispatch_post(
  'test_http_dispatch',
  (SELECT url FROM public.http_dispatch_outbox WHERE target = 'test_http_dispatch' LIMIT 1),
  '{}'::jsonb,
  '{"queue_name":"test_http_dispatch","batch_size":100,"wait_for_completion":false}'::jsonb,
  60000,
  1
);

SELECT results_eq(
  'SELECT calls, timeout_ms FROM test_outbox ORDER BY timeout_ms',
  $$VALUES (2, 8000), (1, 60000)$$,
  'repeated wakeups append rows instead of locking a shared one'
);

SELECT is(
  (
    SELECT count(*)
    FROM pg_index i
    WHERE i.indrelid = 'public.http_dispatch_outbox'::regclass
      AND i.indisunique AND NOT i.indisprimary
  ),
  0::bigint,
  'the outbox has no unique key that writers could contend on'
);

SELECT is(
  (
    SELECT count(*)
    FROM public.http_dispatch_outbox
    WHERE target = 'test_http_dispatch' AND body ? 'apisecret'
  ),
  0::bigint,
  'the API secret is never stored in the outbox'
);

DELETE FROM public.http_dispatch_outbox WHERE target = 'updates_cache_purge';

SELECT public.wake_updates_cache_purge();

SELECT results_eq(
  $$SELECT calls, timeout_ms, body FROM public.http_dispatch_outbox WHERE target = 'updates_cache_purge'$$,
  $$VALUES (1, 5000, '{"wake":true}'::jsonb)$$,
  'the updates cache purge wake goes to the outbox'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.http_dispatch_outbox', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.http_dispatch_outbox', 'INSERT'),
  'the outbox is not exposed to API roles'
);

SELECT * FROM finish();

ROLLBACK;
