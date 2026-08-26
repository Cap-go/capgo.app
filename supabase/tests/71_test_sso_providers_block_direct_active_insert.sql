-- Org admins cannot forge provider_id on SSO providers via PostgREST.
-- pending_verification inserts remain the client path without provider_id.
BEGIN;

SELECT plan(14);

SELECT tests.authenticate_as_service_role();
SELECT tests.create_supabase_user(
  'sso_direct_insert_admin',
  'sso_direct_insert_admin@test.local'
);

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES (
  tests.get_supabase_uid('sso_direct_insert_admin'),
  'sso_direct_insert_admin@test.local',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES (
  '71000000-0000-4000-8000-000000000071',
  tests.get_supabase_uid('sso_direct_insert_admin'),
  'SSO direct insert guard org',
  'sso-direct-insert-guard@test.local'
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
  tests.get_supabase_uid('sso_direct_insert_admin'),
  roles.id,
  public.rbac_scope_org(),
  '71000000-0000-4000-8000-000000000071'::uuid,
  tests.get_supabase_uid('sso_direct_insert_admin'),
  'pgTAP SSO direct insert guard admin',
  true
FROM public.roles
WHERE roles.name = public.rbac_role_org_super_admin()
ON CONFLICT DO NOTHING;

SELECT tests.authenticate_as('sso_direct_insert_admin');

SELECT throws_ok(
  $$
    INSERT INTO public.sso_providers (
      org_id,
      domain,
      provider_id,
      status,
      enforce_sso,
      dns_verification_token
    )
    VALUES (
      '71000000-0000-4000-8000-000000000071',
      'forged-active.sso.test',
      'prov_forged_active',
      'active',
      true,
      'dns-forged-active'
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "sso_providers"',
  'org admin cannot insert an active enforce_sso SSO provider'
);

SELECT throws_ok(
  $$
    INSERT INTO public.sso_providers (
      org_id,
      domain,
      provider_id,
      status,
      enforce_sso,
      dns_verification_token
    )
    VALUES (
      '71000000-0000-4000-8000-000000000071',
      'forged-enforce-pending.sso.test',
      'prov_forged_enforce_pending',
      'pending_verification',
      true,
      'dns-forged-enforce-pending'
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "sso_providers"',
  'org admin cannot insert pending_verification with enforce_sso true'
);

SELECT throws_ok(
  $$
    INSERT INTO public.sso_providers (
      org_id,
      domain,
      provider_id,
      status,
      enforce_sso,
      dns_verification_token,
      dns_verified_at
    )
    VALUES (
      '71000000-0000-4000-8000-000000000071',
      'forged-verified.sso.test',
      'prov_forged_verified',
      'verified',
      false,
      'dns-forged-verified',
      NOW()
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "sso_providers"',
  'org admin cannot insert a pre-verified SSO provider'
);

SELECT throws_ok(
  $$
    INSERT INTO public.sso_providers (
      org_id,
      domain,
      provider_id,
      status,
      enforce_sso,
      dns_verification_token
    )
    VALUES (
      '71000000-0000-4000-8000-000000000071',
      'forged-provider-id.sso.test',
      'prov_forged_provider_id',
      'pending_verification',
      false,
      'dns-forged-provider-id'
    )
  $$,
  '42501',
  'SSO_PROVIDER_PROVIDER_ID_CLIENT_WRITE_DENIED',
  'org admin cannot insert pending_verification with provider_id via PostgREST'
);

SELECT lives_ok(
  $$
    INSERT INTO public.sso_providers (
      id,
      org_id,
      domain,
      status,
      enforce_sso,
      dns_verification_token
    )
    VALUES (
      '71000000-0000-4000-8000-000000000072',
      '71000000-0000-4000-8000-000000000071',
      'pending-ok.sso.test',
      'pending_verification',
      false,
      'dns-pending-ok'
    )
  $$,
  'org admin can insert a pending_verification SSO provider without provider_id'
);

SELECT throws_ok(
  $$
    UPDATE public.sso_providers
    SET provider_id = 'prov_hijacked'
    WHERE id = '71000000-0000-4000-8000-000000000072'
  $$,
  '42501',
  'SSO_PROVIDER_PROVIDER_ID_CLIENT_WRITE_DENIED',
  'org admin cannot change provider_id via PostgREST'
);

SELECT throws_ok(
  $$
    UPDATE public.sso_providers
    SET status = 'active', enforce_sso = true
    WHERE id = '71000000-0000-4000-8000-000000000072'
  $$,
  '42501',
  'SSO_PROVIDER_STATUS_PROMOTION_DENIED',
  'org admin cannot promote a pending provider to active via PostgREST'
);

SELECT throws_ok(
  $$
    UPDATE public.sso_providers
    SET enforce_sso = true
    WHERE id = '71000000-0000-4000-8000-000000000072'
  $$,
  '42501',
  'SSO_PROVIDER_ENFORCE_SSO_DENIED',
  'org admin cannot enable enforce_sso on a pending provider via PostgREST'
);

SELECT throws_ok(
  $$
    UPDATE public.sso_providers
    SET dns_verified_at = NOW()
    WHERE id = '71000000-0000-4000-8000-000000000072'
  $$,
  '42501',
  'SSO_PROVIDER_DNS_VERIFICATION_CLIENT_WRITE_DENIED',
  'org admin cannot stamp dns_verified_at via PostgREST'
);

SELECT tests.authenticate_as_service_role();

INSERT INTO public.sso_providers (
  id,
  org_id,
  domain,
  provider_id,
  status,
  enforce_sso,
  dns_verification_token,
  dns_verified_at
)
VALUES (
  '71000000-0000-4000-8000-000000000073',
  '71000000-0000-4000-8000-000000000071',
  'verified-no-dns.sso.test',
  'prov_verified_no_dns',
  'verified',
  false,
  'dns-verified-no-dns',
  NULL
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.sso_providers (
  id,
  org_id,
  domain,
  provider_id,
  status,
  enforce_sso,
  dns_verification_token,
  dns_verified_at
)
VALUES (
  '71000000-0000-4000-8000-000000000074',
  '71000000-0000-4000-8000-000000000071',
  'active-domain-change.sso.test',
  'prov_active_domain_change',
  'active',
  true,
  'dns-active-domain-change',
  NOW()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.sso_providers (
  id,
  org_id,
  domain,
  provider_id,
  status,
  enforce_sso,
  dns_verification_token,
  dns_verified_at
)
VALUES (
  '71000000-0000-4000-8000-000000000075',
  '71000000-0000-4000-8000-000000000071',
  'active-enforce.sso.test',
  'prov_active_enforce',
  'active',
  false,
  'dns-active-enforce',
  NOW()
)
ON CONFLICT (id) DO NOTHING;

SELECT tests.authenticate_as('sso_direct_insert_admin');

SELECT throws_ok(
  $$
    UPDATE public.sso_providers
    SET status = 'active'
    WHERE id = '71000000-0000-4000-8000-000000000073'
  $$,
  '42501',
  'SSO_PROVIDER_STATUS_PROMOTION_DENIED',
  'org admin cannot promote verified provider without dns_verified_at'
);

SELECT throws_ok(
  $$
    UPDATE public.sso_providers
    SET enforce_sso = true
    WHERE id = '71000000-0000-4000-8000-000000000075'
  $$,
  '42501',
  'SSO_PROVIDER_ENFORCE_SSO_DENIED',
  'org admin cannot enable enforce_sso on active provider via PostgREST'
);

SELECT throws_ok(
  $$
    UPDATE public.sso_providers
    SET domain = 'hijacked.sso.test'
    WHERE id = '71000000-0000-4000-8000-000000000074'
  $$,
  '42501',
  'SSO_PROVIDER_DOMAIN_CHANGE_DENIED',
  'org admin cannot change domain on an active enforce_sso provider'
);

SELECT tests.authenticate_as_service_role();

SELECT lives_ok(
  $$
    INSERT INTO public.sso_providers (
      org_id,
      domain,
      provider_id,
      status,
      enforce_sso,
      dns_verification_token,
      dns_verified_at
    )
    VALUES (
      '71000000-0000-4000-8000-000000000071',
      'service-role-active.sso.test',
      'prov_service_role_active',
      'active',
      true,
      'dns-service-role-active',
      NOW()
    )
  $$,
  'service_role can still insert a legitimate active SSO provider'
);

SELECT lives_ok(
  $$
    UPDATE public.sso_providers
    SET provider_id = 'prov_service_role_bound'
    WHERE id = '71000000-0000-4000-8000-000000000072'
  $$,
  'service_role can set provider_id on a pending SSO provider'
);

SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
