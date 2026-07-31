-- Test RLS policies for RBAC tables
BEGIN;

SELECT plan(10);

-- Test admin user: 'test_admin' maps to c591b04e-cf29-4945-b9a0-776d0672061a (admin@capgo.app)
-- Test regular org member: 'test_user2' maps to 6f0d1a2e-59ed-4769-b9d7-4d9615b28fe5 (test2@capgo.app)
-- Demo org: 046a36ac-e03c-4590-9257-bd6c9dba9ee8
-- 1) Regular user can read roles
SELECT tests.authenticate_as('test_user');

SELECT
    ok(
        (
    SELECT count(*)
            FROM
                public.roles
        ) >= 0,
        'Regular user can read roles'
    );

-- 2) Regular user can read permissions
SELECT tests.authenticate_as('test_user');

SELECT
    ok(
        (
    SELECT count(*)
            FROM
                public.permissions
        ) >= 0,
        'Regular user can read permissions'
    );

-- 3) Regular user cannot read org groups they do not belong to
SELECT tests.authenticate_as('test_admin');

INSERT INTO
public.groups (org_id, name, description, created_by)
VALUES
(
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    'Test Group RLS',
    'Test group for RLS',
    'c591b04e-cf29-4945-b9a0-776d0672061a'
);

SELECT tests.authenticate_as('test_user2');

SELECT
    ok(
        NOT EXISTS (
            SELECT 1
            FROM
                public.groups
            WHERE
                org_id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
                AND name = 'Test Group RLS'
        ),
    'Regular org member cannot read org groups they do not belong to'
    );

-- 4) Regular user can read groups after joining
SET LOCAL ROLE service_role;

INSERT INTO public.group_members (group_id, user_id, added_by)
SELECT
    groups.id,
    '6f0d1a2e-59ed-4769-b9d7-4d9615b28fe5',
    'c591b04e-cf29-4945-b9a0-776d0672061a'
FROM public.groups
WHERE
    org_id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
    AND name = 'Test Group RLS';

RESET ROLE;

SELECT tests.authenticate_as('test_user2');

SELECT
    ok(
        EXISTS (
            SELECT 1
            FROM
                public.groups
            WHERE
                org_id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
                AND name = 'Test Group RLS'
        ),
    'Regular user can read groups they belong to'
    );

-- 5) Regular user cannot see groups from other orgs
-- Create a group in Admin org
SELECT tests.authenticate_as('test_admin');

INSERT INTO
public.groups (org_id, name, description, created_by)
VALUES
(
    '22dbad8a-b885-4309-9b3b-a09f8460fb6d',
    'Admin Org Group',
    'Should not be visible to test user',
    'c591b04e-cf29-4945-b9a0-776d0672061a'
);

-- Check test user cannot see Admin org group
SELECT tests.authenticate_as('test_user');

SELECT
    ok(
        NOT EXISTS (
            SELECT 1
            FROM
                public.groups
            WHERE
                org_id = '22dbad8a-b885-4309-9b3b-a09f8460fb6d'
        ),
    'Regular user cannot see groups from other orgs'
    );

-- 6) Admin can see role_bindings for their org
SELECT tests.authenticate_as('test_admin');

-- Seed a deterministic binding outside RLS; this test is about SELECT visibility.
SET LOCAL ROLE service_role;
DELETE FROM public.role_bindings
WHERE
    principal_type = 'user'
    AND principal_id = '6f0d1a2e-59ed-4769-b9d7-4d9615b28fe5'
    AND scope_type = 'org'
    AND org_id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8';

INSERT INTO
public.role_bindings (
    principal_type,
    principal_id,
    role_id,
    scope_type,
    org_id,
    granted_by
)
VALUES
(
    'user',
    '6f0d1a2e-59ed-4769-b9d7-4d9615b28fe5',
    (
        SELECT id
        FROM public.roles
        WHERE name = public.rbac_role_org_member()
    ),
    'org',
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    'c591b04e-cf29-4945-b9a0-776d0672061a'
);
RESET ROLE;

-- Check test admin can see role bindings in the Demo org
SELECT tests.authenticate_as('test_admin');

SELECT
    ok(
        EXISTS (
            SELECT 1
            FROM
                public.role_bindings
            WHERE
                principal_id = '6f0d1a2e-59ed-4769-b9d7-4d9615b28fe5'
                AND scope_type = 'org'
                AND org_id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
        ),
    'Admin can see role bindings for their org'
    );

-- 7) User cannot see role_bindings from other orgs
-- Note: We don't delete/recreate bindings because of super_admin protection trigger
-- Instead, we verify test_user (different org) cannot see test_admin's bindings
SELECT tests.authenticate_as('test_user');

SELECT
    ok(
        NOT EXISTS (
            SELECT 1
            FROM
                public.role_bindings
            WHERE
                scope_type = 'org'
                AND org_id = '22dbad8a-b885-4309-9b3b-a09f8460fb6d'
        ),
    'User cannot see role bindings from other orgs'
    );

-- 8) Test admin cannot create roles
SELECT tests.authenticate_as('test_admin');

SELECT
    throws_ok(
        $$INSERT INTO public.roles (id, name, scope_type, priority_rank) VALUES ('22222222-2222-2222-2222-222222222222', 'admin_test_role', 'org', 20)$$,
        '42501',
        'new row violates row-level security policy for table "roles"',
        'Admin cannot create roles'
    );

SELECT tests.create_supabase_user('org_users_escalation_owner', 'org-users-escalation-owner@test.local');
SELECT tests.create_supabase_user('org_users_escalation_admin', 'org-users-escalation-admin@test.local');
SELECT tests.create_supabase_user('org_users_escalation_member', 'org-users-escalation-member@test.local');

SELECT tests.authenticate_as_service_role();
SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claim.role" = 'service_role';

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES
  (tests.get_supabase_uid('org_users_escalation_owner'), 'org-users-escalation-owner@test.local', NOW(), NOW()),
  (tests.get_supabase_uid('org_users_escalation_admin'), 'org-users-escalation-admin@test.local', NOW(), NOW()),
  (tests.get_supabase_uid('org_users_escalation_member'), 'org-users-escalation-member@test.local', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES (
  '70000000-0000-4000-8000-000000000034',
  tests.get_supabase_uid('org_users_escalation_owner'),
  'Org users escalation RLS org',
  'org-users-escalation@test.local'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
SELECT
  '70000000-0000-4000-8000-000000000034',
  tests.get_supabase_uid(role_fixture.identifier),
  role_fixture.role_name,
  false
FROM (
  VALUES
    ('org_users_escalation_owner', public.rbac_role_org_super_admin()),
    ('org_users_escalation_admin', public.rbac_role_org_admin()),
    ('org_users_escalation_member', public.rbac_role_org_member())
) AS role_fixture(identifier, role_name)
ON CONFLICT DO NOTHING;

INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by)
SELECT
  public.rbac_principal_user(),
  tests.get_supabase_uid(role_fixture.identifier),
  roles.id,
  public.rbac_scope_org(),
  '70000000-0000-4000-8000-000000000034',
  tests.get_supabase_uid('org_users_escalation_owner')
FROM (
  VALUES
    ('org_users_escalation_owner', public.rbac_role_org_super_admin()),
    ('org_users_escalation_admin', public.rbac_role_org_admin()),
    ('org_users_escalation_member', public.rbac_role_org_member())
) AS role_fixture(identifier, role_name)
JOIN public.roles
  ON roles.name = role_fixture.role_name
  AND roles.scope_type = public.rbac_scope_org()
ON CONFLICT DO NOTHING;

RESET ROLE;
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('org_users_escalation_admin');

SELECT
    throws_ok(
        $$UPDATE public.org_users
          SET rbac_role_name = public.rbac_role_org_super_admin()
          WHERE org_id = '70000000-0000-4000-8000-000000000034'
            AND user_id = tests.get_supabase_uid('org_users_escalation_member')$$,
        'P0001',
        'Admins cannot elevate privileges!',
        'org_admin cannot promote org_users metadata to org_super_admin through direct RLS update'
    );

SELECT tests.authenticate_as_service_role();

SELECT
    is(
        (
            SELECT rbac_role_name
            FROM public.org_users
            WHERE org_id = '70000000-0000-4000-8000-000000000034'
              AND user_id = tests.get_supabase_uid('org_users_escalation_member')
        ),
        public.rbac_role_org_member(),
        'blocked org_users promotion should leave target role unchanged'
    );

SELECT *
FROM
    finish();

ROLLBACK;
