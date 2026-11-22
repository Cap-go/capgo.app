BEGIN;

SELECT plan(11);

INSERT INTO public.apps (owner_org, app_id, icon_url, name, user_id)
VALUES (
  '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
  'com.test.terminal.session',
  '',
  'Terminal session',
  '6aa76066-55ef-4238-ade6-0b32334a4097'
);

UPDATE public.orgs
SET cloud_terminal_enabled = true
WHERE id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8';

UPDATE public.stripe_info
SET status = 'succeeded', is_good_plan = true
WHERE customer_id = (
  SELECT customer_id FROM public.orgs WHERE id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
);

SELECT tests.authenticate_as_service_role();

SELECT ok(
  public.terminal_org_entitled('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
  'entitled org passes terminal_org_entitled'
);

UPDATE public.stripe_info
SET is_good_plan = false
WHERE customer_id = (
  SELECT customer_id FROM public.orgs WHERE id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
);

SELECT is(
  public.terminal_org_entitled('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
  false,
  'unpaid plan blocks terminal'
);

UPDATE public.stripe_info
SET is_good_plan = true
WHERE customer_id = (
  SELECT customer_id FROM public.orgs WHERE id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
);

UPDATE public.orgs
SET cloud_terminal_enabled = false
WHERE id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8';

SELECT is(
  public.terminal_org_entitled('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
  false,
  'disabled flag blocks terminal'
);

UPDATE public.orgs
SET cloud_terminal_enabled = true
WHERE id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8';

SELECT is(
  (public.terminal_session_reserve(
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s1',
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    'com.test.terminal.session',
    NULL::bigint,
    60,
    2
  )->>'ok')::boolean,
  true,
  'first session reserves'
);

SELECT is(
  public.terminal_count_active_sessions('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
  1,
  'one active session counted'
);

SELECT is(
  (public.terminal_session_reserve(
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s2',
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    'com.test.terminal.session',
    NULL::bigint,
    60,
    2
  )->>'ok')::boolean,
  true,
  'second session reserves'
);

SELECT is(
  (public.terminal_session_reserve(
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s3',
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    'com.test.terminal.session',
    NULL::bigint,
    60,
    2
  )->>'error'),
  'concurrency_limit',
  'third session hits concurrency cap'
);

SELECT ok(
  public.terminal_session_finish(
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s1',
    'test'
  ) >= 1,
  'finish bills at least one minute'
);

SELECT is(
  (SELECT status FROM public.terminal_sessions
   WHERE session_key = '046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s1'),
  'ended',
  'finished session is ended'
);

SELECT ok(
  (SELECT billed_minutes FROM public.terminal_sessions
   WHERE session_key = '046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s1') >= 1,
  'billed_minutes persisted'
);

SELECT tests.authenticate_as('test_user');

SELECT throws_ok(
  $$ SELECT * FROM public.terminal_sessions $$,
  '42501',
  NULL,
  'authenticated cannot read terminal_sessions'
);

SELECT * FROM finish();
ROLLBACK;