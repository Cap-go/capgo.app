BEGIN;

SELECT plan(8);

SELECT tests.create_supabase_user('org_owner_self_owner', 'org_owner_self_owner@test.local');
SELECT tests.create_supabase_user('org_owner_self_successor', 'org_owner_self_successor@test.local');
SELECT tests.create_supabase_user('org_owner_self_peer', 'org_owner_self_peer@test.local');

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES
  (tests.get_supabase_uid('org_owner_self_owner'), 'org_owner_self_owner@test.local', NOW(), NOW()),
  (tests.get_supabase_uid('org_owner_self_successor'), 'org_owner_self_successor@test.local', NOW(), NOW()),
  (tests.get_supabase_uid('org_owner_self_peer'), 'org_owner_self_peer@test.local', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.orgs (id, created_by, name, management_email, enforcing_2fa)
VALUES
  (
    '70000000-0000-4000-8000-000000000061',
    tests.get_supabase_uid('org_owner_self_owner'),
    'Org owner self removal transfer',
    'org-owner-self-transfer@test.local',
    false
  ),
  (
    '70000000-0000-4000-8000-000000000062',
    tests.get_supabase_uid('org_owner_self_owner'),
    'Org owner protected from peer removal',
    'org-owner-self-protected@test.local',
    false
  ),
  (
    '70000000-0000-4000-8000-000000000063',
    tests.get_supabase_uid('org_owner_self_owner'),
    'Org owner last super admin guard',
    'org-owner-self-last-super@test.local',
    false
  ),
  (
    '70000000-0000-4000-8000-000000000064',
    tests.get_supabase_uid('org_owner_self_owner'),
    'Org owner requires two factor authentication',
    'org-owner-self-2fa@test.local',
    true
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.org_users (user_id, org_id, rbac_role_name, is_invite)
VALUES
  (tests.get_supabase_uid('org_owner_self_successor'), '70000000-0000-4000-8000-000000000061', public.rbac_role_org_member(), false),
  (tests.get_supabase_uid('org_owner_self_peer'), '70000000-0000-4000-8000-000000000062', public.rbac_role_org_member(), false)
ON CONFLICT DO NOTHING;

INSERT INTO public.role_bindings (
  principal_type,
  principal_id,
  role_id,
  scope_type,
  org_id,
  granted_by,
  reason,
  is_direct
)
SELECT
  public.rbac_principal_user(),
  members.user_id,
  roles.id,
  public.rbac_scope_org(),
  members.org_id,
  tests.get_supabase_uid('org_owner_self_owner'),
  'pgTAP org ownership transfer member fixture',
  true
FROM (
  VALUES
    (tests.get_supabase_uid('org_owner_self_successor'), '70000000-0000-4000-8000-000000000061'::uuid),
    (tests.get_supabase_uid('org_owner_self_peer'), '70000000-0000-4000-8000-000000000062'::uuid)
) AS members(user_id, org_id)
CROSS JOIN public.roles AS roles
WHERE roles.name = public.rbac_role_org_member()
  AND roles.scope_type = public.rbac_scope_org()
ON CONFLICT DO NOTHING;

SELECT tests.authenticate_as('org_owner_self_owner');

SELECT is(
  public.update_org_member_role(
    '70000000-0000-4000-8000-000000000061'::uuid,
    tests.get_supabase_uid('org_owner_self_successor'),
    public.rbac_role_org_super_admin()
  ),
  'OK',
  'owner can promote a successor to org_super_admin'
);

SELECT is(
  public.delete_org_member_role(
    '70000000-0000-4000-8000-000000000061'::uuid,
    tests.get_supabase_uid('org_owner_self_owner')
  ),
  'OK',
  'owner can remove themselves after another org_super_admin exists'
);

SELECT tests.clear_authentication();
SELECT tests.authenticate_as_service_role();

SELECT is(
  (
    SELECT created_by
    FROM public.orgs
    WHERE id = '70000000-0000-4000-8000-000000000061'
  ),
  tests.get_supabase_uid('org_owner_self_successor'),
  'ownership transfers to the promoted successor'
);

SELECT tests.clear_authentication();
SELECT tests.authenticate_as('org_owner_self_owner');

SELECT is(
  public.update_org_member_role(
    '70000000-0000-4000-8000-000000000062'::uuid,
    tests.get_supabase_uid('org_owner_self_peer'),
    public.rbac_role_org_super_admin()
  ),
  'OK',
  'owner can promote a peer super admin on the protected org'
);

SELECT tests.clear_authentication();
SELECT tests.authenticate_as('org_owner_self_peer');

SELECT throws_like(
  $$
    SELECT public.delete_org_member_role(
      '70000000-0000-4000-8000-000000000062'::uuid,
      tests.get_supabase_uid('org_owner_self_owner')
    )
  $$,
  '%CANNOT_CHANGE_OWNER_ROLE%',
  'non-owner super admin cannot remove the org owner'
);

SELECT tests.clear_authentication();
SELECT tests.authenticate_as_service_role();

SELECT is(
  (
    SELECT created_by
    FROM public.orgs
    WHERE id = '70000000-0000-4000-8000-000000000062'
  ),
  tests.get_supabase_uid('org_owner_self_owner'),
  'org owner remains unchanged after blocked peer removal'
);

SELECT tests.clear_authentication();
SELECT tests.authenticate_as('org_owner_self_peer');

SELECT tests.clear_authentication();
SELECT tests.authenticate_as('org_owner_self_owner');

SELECT throws_like(
  $$
    SELECT public.delete_org_member_role(
      '70000000-0000-4000-8000-000000000064'::uuid,
      tests.get_supabase_uid('org_owner_self_owner')
    )
  $$,
  '%NO_PERMISSION_TO_UPDATE_ROLES%',
  'enforcing 2FA blocks owner removal when the caller has no second factor'
);

SELECT throws_like(
  $$
    SELECT public.delete_org_member_role(
      '70000000-0000-4000-8000-000000000063'::uuid,
      tests.get_supabase_uid('org_owner_self_owner')
    )
  $$,
  '%CANNOT_REMOVE_LAST_SUPER_ADMIN%',
  'owner cannot remove themselves when no successor super admin exists'
);

SELECT * FROM finish();

ROLLBACK;
