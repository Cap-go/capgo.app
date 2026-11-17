BEGIN;

SELECT plan(25);

-- Org from seed.sql; the app id is free until it is created below.
SELECT is(
  public.begin_app_storage_cleanup_pass('com.test.storage.cleanup', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 0, 120, '{"app_id":"com.test.storage.cleanup","owner_org":"046a36ac-e03c-4590-9257-bd6c9dba9ee8"}'::jsonb),
  'claimed',
  'pass 0 is claimed while the app id is free'
);

SELECT is(
  (SELECT pass FROM public.app_storage_cleanups WHERE app_id = 'com.test.storage.cleanup'),
  0,
  'the claimed pass is recorded before the message is acknowledged'
);

SELECT ok(
  public.record_app_deletion_once('com.test.storage.cleanup', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', '2026-01-01T00:00:00Z', '[]'::jsonb)
  AND NOT public.record_app_deletion_once('com.test.storage.cleanup', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', '2026-01-01T00:00:00Z', '[]'::jsonb),
  'a deletion is recorded once per cleanup'
);

SELECT is(
  (SELECT count(*)::integer FROM public.deleted_apps WHERE app_id = 'com.test.storage.cleanup'),
  1,
  'a replayed pass 0 adds no second deleted_apps row'
);

SELECT is(
  public.begin_app_storage_cleanup_pass('com.test.storage.cleanup', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 0, 120, '{"app_id":"com.test.storage.cleanup","owner_org":"046a36ac-e03c-4590-9257-bd6c9dba9ee8"}'::jsonb),
  'running',
  'a duplicate delivery of a running pass is not claimed'
);

CREATE TEMP TABLE cleanup_msgs AS
SELECT
  public.finish_app_storage_cleanup_pass('com.test.storage.cleanup', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 0, false, 5, 120) AS follow_up_id;

SELECT isnt((SELECT follow_up_id FROM cleanup_msgs), NULL, 'an unfinished pass queues the next one');

SELECT is(
  (SELECT message -> 'payload' ->> 'storage_cleanup_pass' FROM pgmq.q_on_app_delete WHERE msg_id = (SELECT follow_up_id FROM cleanup_msgs)),
  '1',
  'the next message carries the next pass'
);

SELECT ok(
  (SELECT vt > pg_catalog.now() + interval '3 seconds' FROM pgmq.q_on_app_delete WHERE msg_id = (SELECT follow_up_id FROM cleanup_msgs)),
  'the next pass is delayed'
);

SELECT is(
  public.begin_app_storage_cleanup_pass('com.test.storage.cleanup', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 0, 120, '{"app_id":"com.test.storage.cleanup","owner_org":"046a36ac-e03c-4590-9257-bd6c9dba9ee8"}'::jsonb),
  'superseded',
  'pass 0 delivered again after it finished is not claimed'
);

SELECT is(
  public.begin_app_storage_cleanup_pass('com.test.storage.cleanup', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 1, 120, '{"app_id":"com.test.storage.cleanup","owner_org":"046a36ac-e03c-4590-9257-bd6c9dba9ee8"}'::jsonb),
  'claimed',
  'the queued pass is claimed'
);

-- Pass 1 never finished: the sweeper queues pass 2 and pass 1 loses ownership.
UPDATE public.app_storage_cleanups SET due_at = pg_catalog.now() - interval '1 minute'
WHERE app_id = 'com.test.storage.cleanup';

SELECT is(public.requeue_stalled_app_storage_cleanups(100), 1, 'the sweeper requeues a stalled pass');

SELECT is(
  (SELECT pass FROM public.app_storage_cleanups WHERE app_id = 'com.test.storage.cleanup'),
  2,
  'the sweeper counts the requeue as a pass'
);

SELECT is(
  public.begin_app_storage_cleanup_pass('com.test.storage.cleanup', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 1, 120, '{"app_id":"com.test.storage.cleanup","owner_org":"046a36ac-e03c-4590-9257-bd6c9dba9ee8"}'::jsonb),
  'superseded',
  'a replaced message cannot start a second chain'
);

SELECT is(
  public.finish_app_storage_cleanup_pass('com.test.storage.cleanup', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 1, false, 5, 120),
  NULL,
  'a pass that lost ownership queues nothing'
);

SELECT is(
  (SELECT pass FROM public.app_storage_cleanups WHERE app_id = 'com.test.storage.cleanup'),
  2,
  'a pass that lost ownership leaves the state alone'
);

INSERT INTO public.apps (owner_org, app_id, icon_url, name, user_id)
VALUES (
  '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
  'com.test.storage.cleanup',
  '',
  'Storage cleanup',
  '6aa76066-55ef-4238-ade6-0b32334a4097'
);

SELECT is(
  (SELECT count(*)::integer FROM public.app_storage_cleanups WHERE app_id = 'com.test.storage.cleanup' AND owner_org = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
  0,
  'recreating the app clears its cleanup state'
);

SELECT is(
  public.begin_app_storage_cleanup_pass('com.test.storage.cleanup', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 2, 120, '{"app_id":"com.test.storage.cleanup","owner_org":"046a36ac-e03c-4590-9257-bd6c9dba9ee8"}'::jsonb),
  'recreated',
  'no pass is claimed once the app id exists again in that org'
);

-- Recreating an app only clears its state: a follow-up message queued before
-- (or replayed after) that finds no state and is rejected at its claim.
SELECT is(
  public.begin_app_storage_cleanup_pass('com.test.storage.cleanup.stale', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 2, 120, '{"app_id":"com.test.storage.cleanup.stale","owner_org":"046a36ac-e03c-4590-9257-bd6c9dba9ee8"}'::jsonb),
  'superseded',
  'a follow-up pass without cleanup state is rejected'
);

SELECT is(
  public.finish_app_storage_cleanup_pass('com.test.storage.cleanup', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 2, false, 5, 120),
  NULL,
  'an in-flight pass does not queue another one once the app id exists again'
);

SELECT is(
  (SELECT count(*)::integer FROM public.app_storage_cleanups WHERE app_id = 'com.test.storage.cleanup'),
  0,
  'no cleanup state is left for the recreated app'
);

-- Pass 0 died before it finished: the sweeper replays pass 0 from the stored
-- record instead of skipping to storage-only passes.
SELECT is(
  public.begin_app_storage_cleanup_pass('com.test.storage.replay', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 0, 120, '{"app_id":"com.test.storage.replay","owner_org":"046a36ac-e03c-4590-9257-bd6c9dba9ee8","created_at":"2026-01-01T00:00:00Z"}'::jsonb),
  'claimed',
  'pass 0 of another deletion is claimed'
);

UPDATE public.app_storage_cleanups SET due_at = pg_catalog.now() - interval '1 minute'
WHERE app_id = 'com.test.storage.replay';

SELECT is(public.requeue_stalled_app_storage_cleanups(100), 1, 'the sweeper requeues the stalled pass 0');

SELECT is(
  (SELECT message -> 'payload' -> 'old_record' ->> 'created_at'
   FROM pgmq.q_on_app_delete
   WHERE message -> 'payload' -> 'old_record' ->> 'app_id' = 'com.test.storage.replay'
     AND NOT (message -> 'payload' ? 'storage_cleanup_pass')),
  '2026-01-01T00:00:00Z',
  'the replayed pass 0 carries the stored apps row'
);

SELECT is(
  public.begin_app_storage_cleanup_pass('com.test.storage.replay', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 0, 120, '{}'::jsonb),
  'claimed',
  'the replayed pass 0 is claimed'
);

SELECT ok(
  NOT pg_catalog.has_function_privilege('authenticated', 'public.begin_app_storage_cleanup_pass(text, uuid, integer, integer, jsonb)', 'EXECUTE')
  AND NOT pg_catalog.has_function_privilege('anon', 'public.finish_app_storage_cleanup_pass(text, uuid, integer, boolean, integer, integer)', 'EXECUTE')
  AND NOT pg_catalog.has_function_privilege('authenticated', 'public.requeue_stalled_app_storage_cleanups(integer)', 'EXECUTE'),
  'clients cannot drive storage cleanup passes'
);

SELECT * FROM finish();

ROLLBACK;
