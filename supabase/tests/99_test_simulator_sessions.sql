BEGIN;

SELECT plan(24);

INSERT INTO public.apps (owner_org, app_id, icon_url, name, user_id)
VALUES (
  '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
  'com.test.simulator.session',
  '',
  'Simulator session',
  '6aa76066-55ef-4238-ade6-0b32334a4097'
);

INSERT INTO public.simulator_sessions (
  id, owner_org, app_id, platform, status, requested_by, max_duration_minutes, started_at, last_activity_at
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
    now() - interval '2 hours',
    now() - interval '2 minutes'
  ),
  (
    '99000000-0000-4000-8000-000000000002',
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    'com.test.simulator.session',
    'android',
    'in-progress',
    '6aa76066-55ef-4238-ade6-0b32334a4097',
    40,
    now() - interval '4 minutes',
    now() - interval '4 minutes'
  );

SELECT tests.create_supabase_user('sim_bill_user', 'sim_bill_user@test.local');
UPDATE public.simulator_sessions
SET requested_by = tests.get_supabase_uid('sim_bill_user')
WHERE id = '99000000-0000-4000-8000-000000000001';
DELETE FROM auth.users WHERE id = tests.get_supabase_uid('sim_bill_user');

SELECT is(
  (SELECT requested_by FROM public.simulator_sessions WHERE id = '99000000-0000-4000-8000-000000000001'),
  NULL,
  'deleting the requester keeps the simulator session'
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
  'only the session past its max duration is expired'
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
  'max duration expiry bills the capped open time'
);

INSERT INTO public.simulator_sessions (
  id, owner_org, app_id, platform, status, requested_by, max_duration_minutes, started_at, last_activity_at
)
VALUES (
  '99000000-0000-4000-8000-000000000004',
  '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
  'com.test.simulator.session',
  'ios',
  'in-progress',
  '6aa76066-55ef-4238-ade6-0b32334a4097',
  40,
  now() - interval '10 minutes',
  now() - interval '10 minutes'
);

SELECT is(
  public.expire_simulator_sessions('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
  1,
  'idle simulators stop after five minutes without activity'
);

SELECT is(
  (
    SELECT build_time_unit
    FROM public.build_logs
    WHERE org_id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
      AND build_id = '99000000-0000-4000-8000-000000000004'
  ),
  300::bigint,
  'idle expiry bills until activity plus five minutes'
);

INSERT INTO public.simulator_sessions (
  id, owner_org, app_id, platform, status, requested_by, max_duration_minutes, started_at, last_activity_at
)
VALUES (
  '99000000-0000-4000-8000-000000000005',
  '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
  'com.test.simulator.session',
  'android',
  'in-progress',
  '6aa76066-55ef-4238-ade6-0b32334a4097',
  40,
  now() - interval '20 minutes',
  now() - interval '2 minutes'
);

SELECT is(
  public.expire_simulator_sessions('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
  0,
  'recent activity keeps a simulator alive past five minutes idle'
);

INSERT INTO public.simulator_sessions (
  id, owner_org, app_id, platform, status, requested_by, max_duration_minutes, started_at, last_activity_at
)
VALUES (
  '99000000-0000-4000-8000-000000000006',
  '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
  'com.test.simulator.session',
  'ios',
  'in-progress',
  '6aa76066-55ef-4238-ade6-0b32334a4097',
  40,
  now() - interval '15 minutes',
  now() - interval '4 minutes'
);

SELECT is(
  public.expire_simulator_sessions('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
  0,
  'four minutes idle is still inside the five minute window'
);

SELECT is(
  public.bump_simulator_session_activity('99000000-0000-4000-8000-000000000006'),
  1,
  'activity bump updates last_activity_at while inside the idle window'
);

SELECT is(
  (
    SELECT COALESCE(last_activity_at, started_at) > now() - make_interval(mins => 5)
    FROM public.simulator_sessions
    WHERE id = '99000000-0000-4000-8000-000000000006'
  ),
  true,
  'bumping activity moves the row back inside the idle window'
);

UPDATE public.simulator_sessions
SET last_activity_at = now() - interval '6 minutes'
WHERE id = '99000000-0000-4000-8000-000000000006';

SELECT is(
  public.bump_simulator_session_activity('99000000-0000-4000-8000-000000000006'),
  0,
  'activity bump is refused once the idle window has elapsed'
);

SELECT is(
  public.expire_simulator_sessions('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
  1,
  'six minutes idle expires after the bump is gone'
);

SELECT is(
  (
    SELECT user_id
    FROM public.build_logs
    WHERE org_id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
      AND build_id = '99000000-0000-4000-8000-000000000001'
  ),
  NULL,
  'usage is kept when the requester is already gone'
);

SELECT is(
  (
    SELECT created_at
    FROM public.build_logs
    WHERE org_id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
      AND build_id = '99000000-0000-4000-8000-000000000001'
  ),
  (
    SELECT started_at + interval '40 minutes'
    FROM public.simulator_sessions
    WHERE id = '99000000-0000-4000-8000-000000000001'
  ),
  'max duration usage is dated when the session ended'
);

UPDATE public.simulator_sessions
SET status = 'stopped'
WHERE id = '99000000-0000-4000-8000-000000000005';

INSERT INTO public.orgs (id, created_by, management_email, name)
VALUES (
  '99000000-0000-4000-8000-000000000098',
  '6aa76066-55ef-4238-ade6-0b32334a4097',
  'sim-transfer@test.local',
  'Simulator transfer org'
);

SELECT set_config('capgo.allow_owner_org_transfer', 'true', true);

SELECT throws_ok(
  $$ UPDATE public.apps
     SET owner_org = '99000000-0000-4000-8000-000000000098'
     WHERE app_id = 'com.test.simulator.session' $$,
  'P0001',
  'Stop the running simulator before transferring this app.',
  'an active simulator blocks the app transfer'
);

SELECT set_config('capgo.allow_owner_org_transfer', 'false', true);

UPDATE public.simulator_sessions
SET started_at = now() - interval '2 hours',
    last_activity_at = now() - interval '2 hours'
WHERE id = '99000000-0000-4000-8000-000000000002';

SELECT set_config('capgo.allow_owner_org_transfer', 'true', true);

UPDATE public.apps
SET owner_org = '99000000-0000-4000-8000-000000000098'
WHERE app_id = 'com.test.simulator.session';

SELECT is(
  (SELECT owner_org FROM public.apps WHERE app_id = 'com.test.simulator.session'),
  '99000000-0000-4000-8000-000000000098'::uuid,
  'an expired simulator does not block the app transfer'
);

SELECT is(
  (SELECT status FROM public.simulator_sessions WHERE id = '99000000-0000-4000-8000-000000000002'),
  'stopped',
  'the transfer settles the expired simulator'
);

SELECT set_config('capgo.allow_owner_org_transfer', 'false', true);

DELETE FROM public.apps WHERE app_id = 'com.test.simulator.session';

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.build_logs
    WHERE org_id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
      AND build_id IN (
        '99000000-0000-4000-8000-000000000001',
        '99000000-0000-4000-8000-000000000002',
        '99000000-0000-4000-8000-000000000004'
      )
  ),
  3,
  'deleting the app keeps the simulator minutes'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'simulator_sessions'
      AND indexname = 'simulator_sessions_app_active_idx'
  ),
  'active simulator sessions are indexed by app'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'simulator_sessions'
      AND indexname = 'simulator_sessions_idle_sweep_idx'
  ),
  'active simulator sessions are indexed for idle sweeps'
);

CREATE FUNCTION pg_temp.simulator_settlement_plan_uses_app_index()
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  line text;
BEGIN
  PERFORM set_config('enable_seqscan', 'off', true);
  FOR line IN EXECUTE $q$
    EXPLAIN
    SELECT id
    FROM public.simulator_sessions
    WHERE app_id = 'com.test.simulator.session'
      AND status IN ('new', 'queued', 'starting', 'in-progress')
  $q$
  LOOP
    IF line LIKE '%simulator_sessions_app_active_idx%' THEN
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
END;
$$;

SELECT ok(
  pg_temp.simulator_settlement_plan_uses_app_index(),
  'app deletion looks up active sessions through the app index'
);

INSERT INTO public.orgs (id, created_by, management_email, name)
VALUES (
  '99000000-0000-4000-8000-000000000099',
  '6aa76066-55ef-4238-ade6-0b32334a4097',
  'sim-delete@test.local',
  'Simulator delete org'
);

INSERT INTO public.apps (owner_org, app_id, icon_url, name, user_id)
VALUES (
  '99000000-0000-4000-8000-000000000099',
  'com.test.simulator.delete',
  '',
  'Simulator delete',
  '6aa76066-55ef-4238-ade6-0b32334a4097'
);

INSERT INTO public.simulator_sessions (
  id, owner_org, app_id, platform, status, requested_by, max_duration_minutes, started_at, last_activity_at
)
VALUES (
  '99000000-0000-4000-8000-000000000003',
  '99000000-0000-4000-8000-000000000099',
  'com.test.simulator.delete',
  'android',
  'in-progress',
  '6aa76066-55ef-4238-ade6-0b32334a4097',
  40,
  now() - interval '1 minute',
  now() - interval '1 minute'
);

DELETE FROM public.orgs WHERE id = '99000000-0000-4000-8000-000000000099';

SELECT is(
  (SELECT count(*)::integer FROM public.orgs WHERE id = '99000000-0000-4000-8000-000000000099'),
  0,
  'deleting an organization with an active simulator succeeds'
);

SELECT * FROM finish();

ROLLBACK;