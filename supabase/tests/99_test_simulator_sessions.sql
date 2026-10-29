BEGIN;

SELECT plan(12);

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
  'expired usage is dated when the session ended'
);

DELETE FROM public.apps WHERE app_id = 'com.test.simulator.session';

SELECT is(
  (
    SELECT count(*)::integer
    FROM public.build_logs
    WHERE org_id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
      AND build_id IN (
        '99000000-0000-4000-8000-000000000001',
        '99000000-0000-4000-8000-000000000002'
      )
  ),
  2,
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
  id, owner_org, app_id, platform, status, requested_by, max_duration_minutes, started_at
)
VALUES (
  '99000000-0000-4000-8000-000000000003',
  '99000000-0000-4000-8000-000000000099',
  'com.test.simulator.delete',
  'android',
  'in-progress',
  '6aa76066-55ef-4238-ade6-0b32334a4097',
  40,
  now() - interval '5 minutes'
);

DELETE FROM public.orgs WHERE id = '99000000-0000-4000-8000-000000000099';

SELECT is(
  (SELECT count(*)::integer FROM public.orgs WHERE id = '99000000-0000-4000-8000-000000000099'),
  0,
  'deleting an organization with an active simulator succeeds'
);

SELECT * FROM finish();

ROLLBACK;
