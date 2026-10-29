BEGIN;

SELECT plan(5);

INSERT INTO public.apps (owner_org, app_id, icon_url, name, user_id)
VALUES (
  '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
  'com.test.simulator.session',
  '',
  'Simulator session',
  '6aa76066-55ef-4238-ade6-0b32334a4097'
);

INSERT INTO public.simulator_sessions (
  id, owner_org, app_id, platform, status, requested_by, max_duration_minutes, started_at
)
VALUES
  (
    '99000000-0000-4000-8000-000000000001',
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    'com.test.simulator.session',
    'ios',
    'in-progress',
    '6aa76066-55ef-4238-ade6-0b32334a4097',
    40,
    now() - interval '2 hours'
  ),
  (
    '99000000-0000-4000-8000-000000000002',
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    'com.test.simulator.session',
    'android',
    'in-progress',
    '6aa76066-55ef-4238-ade6-0b32334a4097',
    40,
    now() - interval '5 minutes'
  );

SELECT tests.authenticate_as('test_user');

SELECT throws_ok(
  $$ SELECT id FROM public.simulator_sessions $$,
  '42501',
  NULL,
  'authenticated clients cannot read simulator sessions'
);

SELECT tests.authenticate_as_service_role();

SELECT is(
  public.expire_simulator_sessions('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
  1,
  'only the session past its duration is expired'
);

SELECT is(
  (SELECT status FROM public.simulator_sessions WHERE id = '99000000-0000-4000-8000-000000000001'),
  'stopped',
  'an expired simulator releases its builder slot'
);

SELECT is(
  (SELECT status FROM public.simulator_sessions WHERE id = '99000000-0000-4000-8000-000000000002'),
  'in-progress',
  'a fresh simulator still occupies its slot'
);

SELECT is(
  (
    SELECT build_time_unit
    FROM public.build_logs
    WHERE org_id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
      AND build_id = '99000000-0000-4000-8000-000000000001'
  ),
  2400::bigint,
  'expiry bills the capped open time'
);

SELECT * FROM finish();

ROLLBACK;
