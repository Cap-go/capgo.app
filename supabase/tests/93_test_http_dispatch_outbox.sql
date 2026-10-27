BEGIN;

SELECT plan(10);

SELECT pgmq.create('test_http_dispatch');

-- net.http_request_queue is shared with pg_net and other sessions, so only
-- count this test queue's requests, relative to a baseline.
CREATE TEMP VIEW test_pg_net_requests AS
SELECT count(*) AS requests
FROM net.http_request_queue
WHERE
  pg_catalog.convert_from(body, 'utf8')::jsonb ->> 'queue_name'
  = 'test_http_dispatch';

CREATE TEMP TABLE pg_net_baseline AS
SELECT requests FROM test_pg_net_requests;

CREATE TEMP VIEW test_outbox AS
SELECT calls, timeout_ms, body
FROM public.http_dispatch_outbox
WHERE target = 'test_http_dispatch';

-- Default (self-host): no targets routed, so pg_net still sends one call per
-- 100 readable messages.
SELECT pgmq.send_batch(
  'test_http_dispatch',
  ARRAY(SELECT '{"function_name":"noop"}'::jsonb FROM generate_series(1, 150))
);

SELECT public.process_function_queue('test_http_dispatch', 100);

SELECT is(
  (SELECT requests FROM test_pg_net_requests) - (SELECT requests FROM pg_net_baseline),
  2::bigint,
  'unrouted queues keep dispatching through pg_net'
);

SELECT is(
  (SELECT count(*) FROM test_outbox),
  0::bigint,
  'unrouted queues write nothing to the outbox'
);

-- Routed: the same wakeup goes to the outbox instead of pg_net.
INSERT INTO public.http_dispatch_targets (target) VALUES ('test_http_dispatch');

TRUNCATE pg_net_baseline;
INSERT INTO pg_net_baseline SELECT requests FROM test_pg_net_requests;

SELECT public.process_function_queue('test_http_dispatch', 100);

SELECT is(
  (SELECT requests FROM test_pg_net_requests) - (SELECT requests FROM pg_net_baseline),
  0::bigint,
  'routed queues send nothing through pg_net'
);

SELECT results_eq(
  'SELECT calls, timeout_ms, body FROM test_outbox',
  $$VALUES (2, 8000, '{"queue_name":"test_http_dispatch","batch_size":100,"wait_for_completion":false}'::jsonb)$$,
  'routed queues write one outbox row with the consumer call count'
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

-- '*' routes every target, including the updates cache purge wake.
DELETE FROM public.http_dispatch_targets WHERE target = 'test_http_dispatch';
INSERT INTO public.http_dispatch_targets (target) VALUES ('*')
ON CONFLICT DO NOTHING;
DELETE FROM public.http_dispatch_outbox WHERE target = 'updates_cache_purge';

SELECT public.wake_updates_cache_purge();

SELECT results_eq(
  $$SELECT calls, timeout_ms, body FROM public.http_dispatch_outbox WHERE target = 'updates_cache_purge'$$,
  $$VALUES (1, 5000, '{"wake":true}'::jsonb)$$,
  'the wildcard target routes the updates cache purge wake'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.http_dispatch_outbox', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.http_dispatch_targets', 'INSERT'),
  'dispatch tables are not exposed to API roles'
);

SELECT * FROM finish();

ROLLBACK;
