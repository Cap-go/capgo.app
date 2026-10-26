BEGIN;

SELECT plan(2);

SELECT pgmq.create('test_dispatch_readable');

-- Hidden for an hour, as if an earlier consumer call were still processing it.
SELECT pgmq.send('test_dispatch_readable', '{"function_name":"noop"}'::jsonb, 3600);

CREATE TEMP TABLE dispatch_baseline AS
SELECT count(*) AS requests FROM net.http_request_queue;

SELECT public.process_function_queue('test_dispatch_readable', 950);

SELECT is(
  (SELECT count(*) FROM net.http_request_queue) - (SELECT requests FROM dispatch_baseline),
  0::bigint,
  'invisible in-flight messages do not trigger consumer calls'
);

SELECT pgmq.send('test_dispatch_readable', '{"function_name":"noop"}'::jsonb);

SELECT public.process_function_queue('test_dispatch_readable', 950);

SELECT is(
  (SELECT count(*) FROM net.http_request_queue) - (SELECT requests FROM dispatch_baseline),
  1::bigint,
  'one readable message triggers exactly one consumer call'
);

SELECT * FROM finish();

ROLLBACK;
