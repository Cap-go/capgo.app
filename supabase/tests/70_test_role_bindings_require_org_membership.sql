-- GHSA-9976-934w-5whq
-- Direct PostgREST INSERT of an app-scoped role_binding must require org membership.
BEGIN;

SELECT plan(6);

SELECT tests.create_supabase_user('rbac_membership_admin', 'rbac-membership-admin@test.local');
SELECT tests.create_supabase_user('rbac_membership_member', 'rbac-membership-member@test.local');
SELECT tests.create_supabase_user('rbac_membership_outsider', 'rbac-membership-outsider@test.local');

SELECT tests.authenticate_as_service_role();
SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claim.role" = 'service_role';

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES
  (tests.get_supabase_uid('rbac_membership_admin'), 'rbac-membership-admin@test.local', NOW(), NOW()),
  (tests.get_supabase_uid('rbac_membership_member'), 'rbac-membership-member@test.local', NOW(), NOW()),
  (tests.get_supabase_uid('rbac_membership_outsider'), 'rbac-membership-outsider@test.local', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES (
  '70000000-0000-4000-8000-000000009976',
  tests.get_supabase_uid('rbac_membership_admin'),
  'Role bindings membership RLS org',
  'rbac-membership@test.local'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.apps (app_id, icon_url, user_id, name, owner_org)
VALUES (
  'com.test.rbac.membership.ghsa9976',
  '',
  tests.get_supabase_uid('rbac_membership_admin'),
  'Role bindings membership app',
  '70000000-0000-4000-8000-000000009976'
)
ON CONFLICT (app_id) DO NOTHING;

INSERT INTO public.app_versions (
  id,
  app_id,
  name,
  owner_org,
  user_id,
  storage_provider,
  deleted
)
VALUES (
  70009976,
  'com.test.rbac.membership.ghsa9976',
  '1.0.0-membership-bundle',
  '70000000-0000-4000-8000-000000009976',
  tests.get_supabase_uid('rbac_membership_admin'),
  'r2',
  false
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
SELECT
  '70000000-0000-4000-8000-000000009976',
  tests.get_supabase_uid(role_fixture.identifier),
  role_fixture.role_name,
  false
FROM (
  VALUES
    ('rbac_membership_admin', public.rbac_role_org_admin()),
    ('rbac_membership_member', public.rbac_role_org_member())
) AS role_fixture(identifier, role_name)
ON CONFLICT DO NOTHING;

INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by)
SELECT
  public.rbac_principal_user(),
  tests.get_supabase_uid(role_fixture.identifier),
  roles.id,
  public.rbac_scope_org(),
  '70000000-0000-4000-8000-000000009976',
  tests.get_supabase_uid('rbac_membership_admin')
FROM (
  VALUES
    ('rbac_membership_admin', public.rbac_role_org_admin()),
    ('rbac_membership_member', public.rbac_role_org_member())
) AS role_fixture(identifier, role_name)
JOIN public.roles
  ON roles.name = role_fixture.role_name
  AND roles.scope_type = public.rbac_scope_org()
ON CONFLICT DO NOTHING;

RESET ROLE;
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('rbac_membership_admin');

SELECT throws_ok(
  $$INSERT INTO public.role_bindings (
      principal_type,
      principal_id,
      role_id,
      scope_type,
      org_id,
      app_id,
      granted_by
    )
    SELECT
      public.rbac_principal_user(),
      tests.get_supabase_uid('rbac_membership_outsider'),
      roles.id,
      public.rbac_scope_app(),
      '70000000-0000-4000-8000-000000009976',
      apps.id,
      tests.get_supabase_uid('rbac_membership_admin')
    FROM public.roles
    JOIN public.apps ON apps.app_id = 'com.test.rbac.membership.ghsa9976'
    WHERE roles.name = public.rbac_role_app_reader()
      AND roles.scope_type = public.rbac_scope_app()$$,
  '42501',
  'new row violates row-level security policy for table "role_bindings"',
  'org admin cannot grant an app-scoped role to a user with no org-scope binding'
);

SELECT lives_ok(
  $$INSERT INTO public.role_bindings (
      principal_type,
      principal_id,
      role_id,
      scope_type,
      org_id,
      app_id,
      granted_by
    )
    SELECT
      public.rbac_principal_user(),
      tests.get_supabase_uid('rbac_membership_member'),
      roles.id,
      public.rbac_scope_app(),
      '70000000-0000-4000-8000-000000009976',
      apps.id,
      tests.get_supabase_uid('rbac_membership_admin')
    FROM public.roles
    JOIN public.apps ON apps.app_id = 'com.test.rbac.membership.ghsa9976'
    WHERE roles.name = public.rbac_role_app_reader()
      AND roles.scope_type = public.rbac_scope_app()$$,
  'org admin can grant an app-scoped role to an existing org member'
);

SELECT lives_ok(
  $$INSERT INTO public.role_bindings (
      principal_type,
      principal_id,
      role_id,
      scope_type,
      org_id,
      granted_by
    )
    SELECT
      public.rbac_principal_user(),
      tests.get_supabase_uid('rbac_membership_outsider'),
      roles.id,
      public.rbac_scope_org(),
      '70000000-0000-4000-8000-000000009976',
      tests.get_supabase_uid('rbac_membership_admin')
    FROM public.roles
    WHERE roles.name = public.rbac_role_org_member()
      AND roles.scope_type = public.rbac_scope_org()$$,
  'org admin can still grant first org-scope membership to a non-member'
);

SELECT throws_ok(
  $$UPDATE public.role_bindings
    SET principal_id = tests.get_supabase_uid('rbac_membership_outsider')
    WHERE principal_id = tests.get_supabase_uid('rbac_membership_member')
      AND scope_type = public.rbac_scope_app()
      AND org_id = '70000000-0000-4000-8000-000000009976'$$,
  '42501',
  'new row violates row-level security policy for table "role_bindings"',
  'org admin cannot retarget an app-scoped binding to a non-member'
);

SELECT throws_ok(
  $$INSERT INTO public.role_bindings (
      principal_type,
      principal_id,
      role_id,
      scope_type,
      org_id,
      app_id,
      granted_by
    )
    SELECT
      public.rbac_principal_user(),
      tests.get_supabase_uid('rbac_membership_member'),
      roles.id,
      public.rbac_scope_app(),
      '00000000-0000-4000-8000-000000000099',
      apps.id,
      tests.get_supabase_uid('rbac_membership_admin')
    FROM public.roles
    JOIN public.apps ON apps.app_id = 'com.test.rbac.membership.ghsa9976'
    WHERE roles.name = public.rbac_role_app_reader()
      AND roles.scope_type = public.rbac_scope_app()$$,
  '42501',
  'new row violates row-level security policy for table "role_bindings"',
  'org admin cannot grant an app-scoped role when org_id mismatches apps.owner_org'
);

SELECT lives_ok(
  $$INSERT INTO public.role_bindings (
      principal_type,
      principal_id,
      role_id,
      scope_type,
      org_id,
      app_id,
      bundle_id,
      granted_by
    )
    SELECT
      public.rbac_principal_user(),
      tests.get_supabase_uid('rbac_membership_member'),
      roles.id,
      public.rbac_scope_bundle(),
      '70000000-0000-4000-8000-000000009976',
      apps.id,
      70009976,
      tests.get_supabase_uid('rbac_membership_admin')
    FROM public.roles
    JOIN public.apps ON apps.app_id = 'com.test.rbac.membership.ghsa9976'
    WHERE roles.name = public.rbac_role_bundle_reader()
      AND roles.scope_type = public.rbac_scope_bundle()$$,
  'org admin can grant a bundle-scoped role to an existing org member'
);

SELECT * FROM finish();

ROLLBACK;
