BEGIN;

SELECT plan(7);

CREATE TEMP TABLE cleanup_msgs AS
SELECT
  public.queue_app_storage_cleanup_pass(
    'com.test.storage.cleanup',
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    pg_catalog.jsonb_build_object(
      'function_name', 'on_app_delete',
      'payload', pg_catalog.jsonb_build_object(
        'type', 'DELETE', 'table', 'apps', 'schema', 'public', 'record', NULL,
        'old_record', pg_catalog.jsonb_build_object('app_id', 'com.test.storage.cleanup', 'owner_org', '046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
        'storage_cleanup_pass', 1
      )
    ),
    5
  ) AS follow_up_id,
  pgmq.send('on_app_delete', pg_catalog.jsonb_build_object(
    'function_name', 'on_app_delete',
    'payload', pg_catalog.jsonb_build_object(
      'type', 'DELETE', 'table', 'apps', 'schema', 'public', 'record', NULL,
      'old_record', pg_catalog.jsonb_build_object('app_id', 'com.test.storage.cleanup', 'owner_org', '046a36ac-e03c-4590-9257-bd6c9dba9ee8')
    )
  )) AS first_pass_id,
  public.queue_app_storage_cleanup_pass(
    'com.test.storage.cleanup',
    '34a8c55d-2d0f-4652-a43f-684c7a9403ac',
    pg_catalog.jsonb_build_object(
      'function_name', 'on_app_delete',
      'payload', pg_catalog.jsonb_build_object(
        'old_record', pg_catalog.jsonb_build_object('app_id', 'com.test.storage.cleanup', 'owner_org', '34a8c55d-2d0f-4652-a43f-684c7a9403ac'),
        'storage_cleanup_pass', 1
      )
    ),
    5
  ) AS other_org_id;

SELECT isnt((SELECT follow_up_id FROM cleanup_msgs), NULL, 'a follow-up pass is queued while the app id is free');

SELECT is(
  (SELECT vt > pg_catalog.now() + interval '3 seconds' FROM pgmq.q_on_app_delete WHERE msg_id = (SELECT follow_up_id FROM cleanup_msgs)),
  true,
  'the follow-up pass is delayed'
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
  (SELECT count(*)::integer FROM pgmq.q_on_app_delete WHERE msg_id = (SELECT follow_up_id FROM cleanup_msgs)),
  0,
  'recreating the app in the same org drops its queued follow-up pass'
);

SELECT is(
  (SELECT count(*)::integer FROM pgmq.q_on_app_delete WHERE msg_id = (SELECT first_pass_id FROM cleanup_msgs)),
  1,
  'the first pass of a deletion is kept'
);

SELECT is(
  (SELECT count(*)::integer FROM pgmq.q_on_app_delete WHERE msg_id = (SELECT other_org_id FROM cleanup_msgs)),
  1,
  'a pass for the same app id in another org is kept'
);

SELECT is(
  public.queue_app_storage_cleanup_pass(
    'com.test.storage.cleanup',
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    '{"function_name":"on_app_delete","payload":{"storage_cleanup_pass":2}}'::jsonb,
    5
  ),
  NULL,
  'no pass is queued once the app id exists again in that org'
);

SELECT ok(
  NOT pg_catalog.has_function_privilege('authenticated', 'public.queue_app_storage_cleanup_pass(text, uuid, jsonb, integer)', 'EXECUTE')
  AND NOT pg_catalog.has_function_privilege('anon', 'public.queue_app_storage_cleanup_pass(text, uuid, jsonb, integer)', 'EXECUTE'),
  'clients cannot queue cleanup passes'
);

SELECT * FROM finish();

ROLLBACK;
