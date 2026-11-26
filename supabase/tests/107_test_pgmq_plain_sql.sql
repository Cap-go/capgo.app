-- 20261126151718_pgmq_plain_sql: pgmq is plain SQL objects, not an extension,
-- and the queue API still works.
BEGIN;

SELECT plan(15);

SELECT ok(
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pgmq'),
  'the pgmq extension is gone'
);

SELECT is(
  (
    SELECT count(*)::int
    FROM pg_catalog.pg_depend AS d
    WHERE d.deptype = 'e'
      AND (
        (d.classid = 'pg_catalog.pg_proc'::regclass
          AND d.objid IN (SELECT p.oid FROM pg_catalog.pg_proc AS p WHERE p.pronamespace = 'pgmq'::regnamespace))
        OR (d.classid = 'pg_catalog.pg_class'::regclass
          AND d.objid IN (SELECT c.oid FROM pg_catalog.pg_class AS c WHERE c.relnamespace = 'pgmq'::regnamespace))
        OR (d.classid = 'pg_catalog.pg_type'::regclass
          AND d.objid IN (SELECT t.oid FROM pg_catalog.pg_type AS t WHERE t.typnamespace = 'pgmq'::regnamespace))
      )
  ),
  0,
  'no object in schema pgmq is an extension member'
);

SELECT has_table('pgmq', 'meta', 'pgmq.meta is still there');

-- Queues created by earlier migrations kept their meta rows and tables.
SELECT ok(
  EXISTS (SELECT 1 FROM pgmq.meta WHERE queue_name = 'cron_email'),
  'pgmq.meta keeps the row of a queue created before the migration'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pgmq.meta AS m
    WHERE pg_catalog.to_regclass(pg_catalog.format('pgmq.%I', 'q_' || m.queue_name)) IS NULL
  ),
  'every pgmq.meta row still has its queue table'
);

SELECT lives_ok(
  $$SELECT pgmq.create('test_pgmq_plain_sql')$$,
  'pgmq.create works'
);
SELECT ok(
  EXISTS (SELECT 1 FROM pgmq.meta WHERE queue_name = 'test_pgmq_plain_sql'),
  'pgmq.create records the new queue in pgmq.meta'
);

SELECT ok(
  pgmq.send('test_pgmq_plain_sql', '{"n":1}'::jsonb) IS NOT NULL,
  'pgmq.send returns a msg_id'
);
SELECT is(
  (SELECT count(*)::int FROM pgmq.send_batch('test_pgmq_plain_sql', ARRAY['{"n":2}', '{"n":3}']::jsonb[])),
  2,
  'pgmq.send_batch returns one msg_id per message'
);

CREATE TEMP TABLE pgmq_plain_sql_read ON COMMIT DROP AS
SELECT * FROM pgmq.read('test_pgmq_plain_sql', 30, 10);

SELECT is(
  (SELECT count(*)::int FROM pgmq_plain_sql_read),
  3,
  'pgmq.read returns the sent messages'
);
SELECT is(
  (SELECT array_agg((message ->> 'n')::int ORDER BY msg_id) FROM pgmq_plain_sql_read),
  ARRAY[1, 2, 3],
  'pgmq.read returns the messages in send order'
);

SELECT ok(
  pgmq.archive('test_pgmq_plain_sql', (SELECT min(msg_id) FROM pgmq_plain_sql_read)),
  'pgmq.archive moves a message'
);
SELECT is(
  (SELECT count(*)::int FROM pgmq.a_test_pgmq_plain_sql),
  1,
  'the archived message is in the archive table'
);

SELECT ok(
  pgmq.drop_queue('test_pgmq_plain_sql'),
  'pgmq.drop_queue works'
);
-- Checked in a later statement: one statement does not see what the function changed.
SELECT ok(
  NOT EXISTS (SELECT 1 FROM pgmq.meta WHERE queue_name = 'test_pgmq_plain_sql')
  AND pg_catalog.to_regclass('pgmq.q_test_pgmq_plain_sql') IS NULL
  AND pg_catalog.to_regclass('pgmq.a_test_pgmq_plain_sql') IS NULL,
  'pgmq.drop_queue removes the queue tables and the meta row'
);

SELECT * FROM finish();

ROLLBACK;
