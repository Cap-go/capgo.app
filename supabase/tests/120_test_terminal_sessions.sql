BEGIN;

SELECT plan(22);

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

-- Floor billing: 119.7s elapsed is 1 whole minute, not 2.
UPDATE public.terminal_sessions
SET started_at = now() - interval '119.7 seconds'
WHERE session_key = '046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s2';

SELECT is(
  public.terminal_session_finish(
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s2',
    'test'
  ),
  1,
  'finish floors 119.7s to 1 billed minute'
);

SELECT is(
  (public.terminal_session_reserve(
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s4',
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    'com.test.terminal.session',
    NULL::bigint,
    60,
    2
  )->>'ok')::boolean,
  true,
  'fourth session reserves after earlier sessions end'
);

UPDATE public.terminal_sessions
SET started_at = now() - interval '59 seconds'
WHERE session_key = '046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s4';

SELECT is(
  public.terminal_session_finish(
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s4',
    'test'
  ),
  1,
  'finish bills the 1 minute minimum for 59s'
);

-- Retried finish: p_ended_at (original teardown time) drives ended_at and billing, not now().
INSERT INTO public.terminal_sessions (session_key, owner_org, app_id, status, started_at)
VALUES
  ('046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s5', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 'com.test.terminal.session', 'active', now() - interval '50 minutes'),
  ('046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s6', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 'com.test.terminal.session', 'active', now() - interval '10 minutes'),
  ('046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s7', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 'com.test.terminal.session', 'active', now() - interval '10 minutes');

SELECT is(
  public.terminal_session_finish('046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s5', 'client_end', now() - interval '45 minutes'),
  5,
  'finish with an earlier p_ended_at bills from that time, not now()'
);

SELECT is(
  (SELECT ended_at FROM public.terminal_sessions WHERE session_key = '046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s5'),
  now() - interval '45 minutes',
  'finish with p_ended_at records ended_at at the original teardown time'
);

SELECT is(
  public.terminal_session_finish('046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s6', 'client_end', now() + interval '1 hour'),
  10,
  'p_ended_at after now() is clamped to now()'
);

SELECT is(
  public.terminal_session_finish('046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s7', 'client_end', now() - interval '20 minutes'),
  1,
  'p_ended_at before started_at is clamped to started_at (1 minute minimum)'
);

SELECT is(
  (SELECT ended_at FROM public.terminal_sessions WHERE session_key = '046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s7'),
  now() - interval '10 minutes',
  'p_ended_at before started_at records ended_at = started_at'
);

-- Reservation returns DB started_at so the DO clock matches the DB expiry.
CREATE TEMP TABLE terminal_s8_reserve ON COMMIT DROP AS
SELECT public.terminal_session_reserve(
  '046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s8',
  '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
  'com.test.terminal.session',
  NULL::bigint,
  60,
  2
) AS result;

SELECT is(
  (SELECT (result->>'started_at_ms')::bigint FROM terminal_s8_reserve),
  (SELECT floor(extract(epoch FROM started_at) * 1000)::bigint
   FROM public.terminal_sessions WHERE session_key = '046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s8'),
  'reserve returns started_at_ms of the created session'
);

UPDATE public.terminal_sessions
SET started_at = now() - interval '7 minutes'
WHERE session_key = '046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s8';

SELECT is(
  (public.terminal_session_reserve(
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8:com.test.terminal.session:s8',
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    'com.test.terminal.session',
    NULL::bigint,
    60,
    2
  )->>'started_at_ms')::bigint,
  floor(extract(epoch FROM now() - interval '7 minutes') * 1000)::bigint,
  'reused reserve returns the original started_at_ms'
);

SELECT tests.authenticate_as('test_user');

SELECT throws_ok(
  $$ SELECT * FROM public.terminal_sessions $$,
  '42501',
  NULL,
  'authenticated cannot read terminal_sessions'
);

SELECT ok(
  obj_description('public.guard_org_billing_columns()'::regprocedure, 'pg_proc')
    LIKE '%Org-create bootstrap may set pending customer_id while capgo.org_creation_bootstrap_org_id matches the row id.%'
  AND obj_description('public.guard_org_billing_columns()'::regprocedure, 'pg_proc')
    LIKE '%has_usage_credits may only change to the usage_credit_grants-derived value.%'
  AND obj_description('public.guard_org_billing_columns()'::regprocedure, 'pg_proc')
    LIKE '%cloud_terminal_enabled%',
  'guard_org_billing_columns comment keeps bootstrap and usage credit wording'
);

SELECT * FROM finish();
ROLLBACK;