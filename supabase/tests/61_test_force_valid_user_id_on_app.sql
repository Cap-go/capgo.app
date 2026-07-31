BEGIN;

SELECT plan(1);

SELECT tests.create_supabase_user('app_owner_enforcement_owner', 'app_owner_enforcement_owner@test.local');
SELECT tests.create_supabase_user('app_owner_enforcement_other', 'app_owner_enforcement_other@test.local');

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES
  (tests.get_supabase_uid('app_owner_enforcement_owner'), 'app_owner_enforcement_owner@test.local', NOW(), NOW()),
  (tests.get_supabase_uid('app_owner_enforcement_other'), 'app_owner_enforcement_other@test.local', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES (
  '61000000-0000-4000-8000-000000000001',
  tests.get_supabase_uid('app_owner_enforcement_owner'),
  'App owner enforcement org',
  'app-owner-enforcement@test.local'
);

INSERT INTO public.apps (id, app_id, icon_url, user_id, name, owner_org)
VALUES (
  '61000000-0000-4000-8000-000000000002',
  'com.test.app-owner-enforcement',
  '',
  tests.get_supabase_uid('app_owner_enforcement_other'),
  'App owner enforcement',
  '61000000-0000-4000-8000-000000000001'
);

SELECT is(
  (SELECT user_id FROM public.apps WHERE app_id = 'com.test.app-owner-enforcement'),
  tests.get_supabase_uid('app_owner_enforcement_owner'),
  'app user_id is enforced from the organization creator on insert'
);

SELECT * FROM finish(); -- noqa: AM04

ROLLBACK;
