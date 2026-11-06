-- org.customer_id is service-managed: user/capgkey roles cannot write it.
BEGIN;

SELECT plan(16);

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
  'pgTAP org customer_id guard fixture',
  true
FROM (
  VALUES
    (tests.get_supabase_uid('org_billing_guard_admin'), public.rbac_role_org_admin()),
    (tests.get_supabase_uid('org_billing_guard_super'), public.rbac_role_org_super_admin())
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
  'PERMISSION_DENIED_ORG_CUSTOMER_ID',
  'org_admin cannot mutate customer_id'
);

SELECT lives_ok(
  $$
    UPDATE public.orgs
    SET name = 'Org billing column guard updated'
    WHERE id = '73000000-0000-4000-8000-000000000073'::uuid
  $$,
  'org_admin can still update org settings columns'
);

SELECT throws_ok(
  $$
    UPDATE public.orgs
    SET auto_top_up_enabled = true,
        auto_top_up_threshold = 5000,
        auto_top_up_monthly_limit = 0
    WHERE id = '73000000-0000-4000-8000-000000000073'::uuid
  $$,
  '42501',
  'PERMISSION_DENIED_ORG_BILLING_COLUMNS',
  'org_admin cannot mutate auto top-up settings'
);

SELECT throws_ok(
  $$
    UPDATE public.orgs
    SET auto_top_up_last_attempt_at = NOW() - INTERVAL '1 day'
    WHERE id = '73000000-0000-4000-8000-000000000073'::uuid
  $$,
  '42501',
  'PERMISSION_DENIED_ORG_BILLING_COLUMNS',
  'org_admin cannot mutate auto top-up cooldown'
);

SELECT throws_ok(
  $$
    UPDATE public.orgs
    SET has_usage_credits = true
    WHERE id = '73000000-0000-4000-8000-000000000073'::uuid
  $$,
  '42501',
  'PERMISSION_DENIED_ORG_BILLING_COLUMNS',
  'org_admin cannot mutate has_usage_credits'
);

SELECT lives_ok(
  $$
    UPDATE public.orgs
    SET name = 'Org billing column guard noop',
        auto_top_up_enabled = false,
        has_usage_credits = false
    WHERE id = '73000000-0000-4000-8000-000000000073'::uuid
  $$,
  'org_admin can resend unchanged billing columns'
);

SELECT tests.authenticate_as('org_billing_guard_super');

SELECT throws_ok(
  $$
    UPDATE public.orgs
    SET customer_id = 'cus_org_billing_guard_730002'
    WHERE id = '73000000-0000-4000-8000-000000000073'::uuid
  $$,
  '42501',
  'PERMISSION_DENIED_ORG_CUSTOMER_ID',
  'org_super_admin cannot mutate customer_id'
);

SELECT throws_ok(
  $$
    UPDATE public.orgs
    SET auto_top_up_threshold = 5000
    WHERE id = '73000000-0000-4000-8000-000000000073'::uuid
  $$,
  '42501',
  'PERMISSION_DENIED_ORG_BILLING_COLUMNS',
  'org_super_admin cannot mutate auto top-up settings directly'
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

SELECT lives_ok(
  $$
    UPDATE public.orgs
    SET auto_top_up_enabled = true,
        auto_top_up_threshold = 25,
        auto_top_up_monthly_limit = 100
    WHERE id = '73000000-0000-4000-8000-000000000073'::uuid
  $$,
  'service_role can update auto top-up settings'
);

SELECT tests.authenticate_as('org_billing_guard_super');

SELECT throws_ok(
  $$
    INSERT INTO public.orgs (id, created_by, name, management_email, customer_id)
    VALUES (
      '73000000-0000-4000-8000-000000000075'::uuid,
      tests.get_supabase_uid('org_billing_guard_super'),
      'Org customer_id insert blocked',
      'org-customer-id-insert-blocked@test.local',
      'cus_org_billing_guard_evil'
    )
  $$,
  '42501',
  'PERMISSION_DENIED_ORG_CUSTOMER_ID',
  'user cannot insert org with customer_id'
);

SELECT throws_ok(
  $$
    INSERT INTO public.orgs (
      id, created_by, name, management_email, auto_top_up_enabled
    )
    VALUES (
      '73000000-0000-4000-8000-000000000076'::uuid,
      tests.get_supabase_uid('org_billing_guard_super'),
      'Org auto top-up insert blocked',
      'org-auto-top-up-insert-blocked@test.local',
      true
    )
  $$,
  '42501',
  'PERMISSION_DENIED_ORG_BILLING_COLUMNS',
  'user cannot insert org with auto top-up enabled'
);

SELECT tests.authenticate_as_service_role();
SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claim.role" = 'service_role';

SELECT lives_ok(
  $$
    INSERT INTO public.orgs (id, created_by, name, management_email)
    VALUES (
      '73000000-0000-4000-8000-000000000074'::uuid,
      tests.get_supabase_uid('org_billing_guard_super'),
      'Org customer_id bootstrap',
      'org-customer-id-bootstrap@test.local'
    )
    ON CONFLICT (id) DO NOTHING
  $$,
  'service_role can insert org without customer_id'
);

SELECT is(
  (SELECT customer_id FROM public.orgs WHERE id = '73000000-0000-4000-8000-000000000074'::uuid),
  'pending_73000000-0000-4000-8000-000000000074',
  'org create bootstrap assigns pending customer_id'
);

-- The has_usage_credits sync trigger may run under a user request role
-- (SECURITY DEFINER caller); grant-derived values must still be accepted.
RESET ROLE;
SET LOCAL "request.jwt.claim.role" = 'authenticated';

SELECT lives_ok(
  $$
    INSERT INTO public.usage_credit_grants (org_id, credits_total, source)
    VALUES ('73000000-0000-4000-8000-000000000073'::uuid, 50, 'manual')
  $$,
  'grant sync can set has_usage_credits under a user request role'
);

SELECT is(
  (SELECT has_usage_credits FROM public.orgs WHERE id = '73000000-0000-4000-8000-000000000073'::uuid),
  true,
  'has_usage_credits follows usage_credit_grants'
);

SELECT tests.clear_authentication();
SELECT set_config('request.headers', '{}', true);

SELECT * FROM finish();

ROLLBACK;
