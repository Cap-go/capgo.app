BEGIN;

SELECT plan(14);

-- Org from seed.sql; the app id is free until it is created below.
SELECT ok(
  public.begin_app_storage_cleanup_pass('com.test.storage.cleanup', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 0, 120),
  'a pass is claimed while the app id is free'
);

SELECT is(
  (SELECT pass FROM public.app_storage_cleanups WHERE app_id = 'com.test.storage.cleanup'),
  0,
  'the claimed pass is recorded before the message is acknowledged'
);

CREATE TEMP TABLE cleanup_msgs AS
SELECT
  public.finish_app_storage_cleanup_pass('com.test.storage.cleanup', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 0, false, 5, 120) AS follow_up_id,
  pgmq.send('on_app_delete', pg_catalog.jsonb_build_object(
    'function_name', 'on_app_delete',
    'payload', pg_catalog.jsonb_build_object(
      'type', 'DELETE', 'table', 'apps', 'schema', 'public', 'record', NULL,
      'old_record', pg_catalog.jsonb_build_object('app_id', 'com.test.storage.cleanup', 'owner_org', '046a36ac-e03c-4590-9257-bd6c9dba9ee8')
    )
  )) AS first_pass_id,
  pgmq.send('on_app_delete', public.app_storage_cleanup_message('com.test.storage.cleanup', '34a8c55d-2d0f-4652-a43f-684c7a9403ac', 1)) AS other_org_id;

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

-- A pass that never finished: the sweeper queues the next one.
UPDATE public.app_storage_cleanups SET due_at = pg_catalog.now() - interval '1 minute'
WHERE app_id = 'com.test.storage.cleanup';

SELECT is(public.requeue_stalled_app_storage_cleanups(100), 1, 'the sweeper requeues a stalled pass');

SELECT is(
  (SELECT pass FROM public.app_storage_cleanups WHERE app_id = 'com.test.storage.cleanup'),
  2,
  'the sweeper counts the requeue as a pass'
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
  (SELECT count(*)::integer FROM pgmq.q_on_app_delete
   WHERE message -> 'payload' ? 'storage_cleanup_pass'
     AND message -> 'payload' -> 'old_record' ->> 'app_id' = 'com.test.storage.cleanup'
     AND message -> 'payload' -> 'old_record' ->> 'owner_org' = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
  0,
  'recreating the app in the same org drops its queued follow-up passes'
);

SELECT is(
  (SELECT count(*)::integer FROM public.app_storage_cleanups WHERE app_id = 'com.test.storage.cleanup' AND owner_org = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
  0,
  'recreating the app clears its cleanup state'
);

SELECT is(
  (SELECT count(*)::integer FROM pgmq.q_on_app_delete WHERE msg_id IN (SELECT first_pass_id FROM cleanup_msgs UNION ALL SELECT other_org_id FROM cleanup_msgs)),
  2,
  'the first pass of a deletion and other orgs'' passes are kept'
);

SELECT ok(
  NOT public.begin_app_storage_cleanup_pass('com.test.storage.cleanup', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 3, 120),
  'a pass is not claimed once the app id exists again in that org'
);

SELECT is(
  public.finish_app_storage_cleanup_pass('com.test.storage.cleanup', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 3, false, 5, 120),
  NULL,
  'an in-flight pass does not queue another one once the app id exists again'
);

SELECT is(
  (SELECT count(*)::integer FROM public.app_storage_cleanups WHERE app_id = 'com.test.storage.cleanup'),
  0,
  'no cleanup state is left for the recreated app'
);

SELECT ok(
  NOT pg_catalog.has_function_privilege('authenticated', 'public.begin_app_storage_cleanup_pass(text, uuid, integer, integer)', 'EXECUTE')
  AND NOT pg_catalog.has_function_privilege('anon', 'public.finish_app_storage_cleanup_pass(text, uuid, integer, boolean, integer, integer)', 'EXECUTE')
  AND NOT pg_catalog.has_function_privilege('authenticated', 'public.requeue_stalled_app_storage_cleanups(integer)', 'EXECUTE'),
  'clients cannot drive storage cleanup passes'
);

SELECT * FROM finish();

ROLLBACK;
