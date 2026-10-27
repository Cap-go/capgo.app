BEGIN;

SELECT plan(2);

SELECT pgmq.create('test_dispatch_readable');

-- Hidden for an hour, as if an earlier consumer call were still processing it.
SELECT pgmq.send('test_dispatch_readable', '{"function_name":"noop"}'::jsonb, 3600);

-- net.http_request_queue is shared with pg_net and other sessions, so only
-- count this test queue's requests, relative to a baseline.
CREATE TEMP VIEW test_queue_requests AS
SELECT count(*) AS requests
FROM net.http_request_queue
WHERE
  pg_catalog.convert_from(body, 'utf8')::jsonb ->> 'queue_name'
  = 'test_dispatch_readable';

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
