BEGIN;

SELECT plan(2);

SELECT pgmq.create('test_dispatch_readable');

-- Hidden for an hour, as if an earlier consumer call were still processing it.
SELECT pgmq.send('test_dispatch_readable', '{"function_name":"noop"}'::jsonb, 3600);

-- Consumer calls this test queue asked for (the outbox target is the queue
-- name), relative to a baseline.
CREATE TEMP VIEW test_queue_requests AS
SELECT coalesce(sum(calls), 0)::bigint AS requests
FROM public.http_dispatch_outbox
WHERE target = 'test_dispatch_readable';

CREATE TEMP TABLE dispatch_baseline AS
SELECT requests FROM test_queue_requests;

SELECT public.process_function_queue('test_dispatch_readable', 950);

SELECT is(
  (SELECT requests FROM test_queue_requests) - (SELECT requests FROM dispatch_baseline),
  0::bigint,
  'invisible in-flight messages do not trigger consumer calls'
);

SELECT pgmq.send('test_dispatch_readable', '{"function_name":"noop"}'::jsonb);

SELECT public.process_function_queue('test_dispatch_readable', 950);

SELECT is(
  (SELECT requests FROM test_queue_requests) - (SELECT requests FROM dispatch_baseline),
  1::bigint,
  'one readable message triggers exactly one consumer call'
);

SELECT * FROM finish();

ROLLBACK;
