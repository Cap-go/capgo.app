-- org.customer_id must not be writable via PostgREST unless org.update_billing is granted.
BEGIN;

SELECT plan(4);

SELECT tests.authenticate_as_service_role();
SELECT tests.create_supabase_user('org_billing_guard_admin', 'org_billing_guard_admin@test.local');
SELECT tests.create_supabase_user('org_billing_guard_super', 'org_billing_guard_super@test.local');

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES
  (tests.get_supabase_uid('org_billing_guard_admin'), 'org_billing_guard_admin@test.local', NOW(), NOW()),
  (tests.get_supabase_uid('org_billing_guard_super'), 'org_billing_guard_super@test.local', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.stripe_info (
  customer_id,
  status,
  product_id,
  subscription_id,
  trial_at,
  is_good_plan
)
VALUES
  (
    'cus_org_billing_guard_730001',
    'succeeded',
    'prod_LQIregjtNduh4q',
    'sub_org_billing_guard_730001',
    NOW() + INTERVAL '15 days',
    true
  ),
  (
    'cus_org_billing_guard_730002',
    'succeeded',
    'prod_LQIregjtNduh4q',
    'sub_org_billing_guard_730002',
    NOW() + INTERVAL '15 days',
    true
  )
ON CONFLICT (customer_id) DO NOTHING;

INSERT INTO public.orgs (id, created_by, name, management_email, customer_id)
VALUES (
  '73000000-0000-4000-8000-000000000073',
  tests.get_supabase_uid('org_billing_guard_super'),
  'Org billing column guard',
  'org-billing-guard@test.local',
  'cus_org_billing_guard_730001'
)
ON CONFLICT (id) DO NOTHING;

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
  '73000000-0000-4000-8000-000000000073'::uuid,
  tests.get_supabase_uid('org_billing_guard_admin'),
  'pgTAP org billing column guard fixture',
  true
FROM (
  VALUES
    (tests.get_supabase_uid('org_billing_guard_admin'), public.rbac_role_org_admin())
) AS members(user_id, role_name)
CROSS JOIN public.roles AS roles
WHERE roles.name = members.role_name
  AND roles.scope_type = public.rbac_scope_org()
ON CONFLICT DO NOTHING;

SELECT tests.authenticate_as('org_billing_guard_admin');

SELECT throws_ok(
  $$
    UPDATE public.orgs
    SET customer_id = NULL
    WHERE id = '73000000-0000-4000-8000-000000000073'::uuid
  $$,
  '42501',
  'PERMISSION_DENIED_ORG_UPDATE_BILLING',
  'org_admin cannot mutate customer_id without org.update_billing'
);

SELECT lives_ok(
  $$
    UPDATE public.orgs
    SET name = 'Org billing column guard updated'
    WHERE id = '73000000-0000-4000-8000-000000000073'::uuid
  $$,
  'org_admin can still update org settings columns'
);

SELECT tests.authenticate_as_service_role();
SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claim.role" = 'service_role';

SELECT lives_ok(
  $$
    UPDATE public.orgs
    SET customer_id = 'cus_org_billing_guard_730002'
    WHERE id = '73000000-0000-4000-8000-000000000073'::uuid
  $$,
  'service_role can update org customer_id'
);

SELECT tests.authenticate_as('org_billing_guard_super');

SELECT lives_ok(
  $$
    UPDATE public.orgs
    SET customer_id = 'cus_org_billing_guard_730001'
    WHERE id = '73000000-0000-4000-8000-000000000073'::uuid
  $$,
  'org creator super admin can update org customer_id with org.update_billing'
);

SELECT tests.clear_authentication();
SELECT set_config('request.headers', '{}', true);

SELECT * FROM finish();

ROLLBACK;
