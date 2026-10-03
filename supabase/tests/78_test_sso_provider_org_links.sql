-- sso_provider_org_links is written only by /private/sso/providers/:id/links
-- (service role / direct Postgres): clients can neither read nor write it,
-- even as super admin of both orgs.
BEGIN;

SELECT plan(7);

SELECT tests.authenticate_as_service_role();
SELECT tests.create_supabase_user(
  'sso_link_admin',
  'sso_link_admin@test.local'
);

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES (
  tests.get_supabase_uid('sso_link_admin'),
  'sso_link_admin@test.local',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES
  (
    '78000000-0000-4000-8000-000000000001',
    tests.get_supabase_uid('sso_link_admin'),
    'SSO link owner org',
    'sso-link-owner@test.local'
  ),
  (
    '78000000-0000-4000-8000-000000000002',
    tests.get_supabase_uid('sso_link_admin'),
    'SSO link linked org',
    'sso-link-linked@test.local'
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
  tests.get_supabase_uid('sso_link_admin'),
  roles.id,
  public.rbac_scope_org(),
  orgs.id,
  tests.get_supabase_uid('sso_link_admin'),
  'pgTAP SSO link super admin',
  true
FROM public.roles
CROSS JOIN (
  VALUES
    ('78000000-0000-4000-8000-000000000001'::uuid),
    ('78000000-0000-4000-8000-000000000002'::uuid)
) AS orgs (id)
WHERE roles.name = public.rbac_role_org_super_admin()
ON CONFLICT DO NOTHING;

INSERT INTO public.sso_providers (id, org_id, domain, status, dns_verification_token)
VALUES (
  '78000000-0000-4000-8000-0000000000aa',
  '78000000-0000-4000-8000-000000000001',
  'sso-link.test.local',
  'active',
  'dns-sso-link'
);

SELECT lives_ok(
  $$
    INSERT INTO public.sso_provider_org_links (sso_provider_id, org_id)
    VALUES ('78000000-0000-4000-8000-0000000000aa', '78000000-0000-4000-8000-000000000002')
  $$,
  'service role can link an org to a provider'
);

SELECT throws_ok(
  $$
    INSERT INTO public.sso_provider_org_links (sso_provider_id, org_id)
    VALUES ('78000000-0000-4000-8000-0000000000aa', '78000000-0000-4000-8000-000000000002')
  $$,
  '23505',
  NULL,
  'an org is linked to a provider at most once'
);

SELECT throws_ok(
  $$
    UPDATE public.sso_provider_org_links
    SET role_mapping = '[]'::jsonb
    WHERE org_id = '78000000-0000-4000-8000-000000000002'
  $$,
  '23514',
  NULL,
  'role_mapping must be a JSON object'
);

SELECT tests.authenticate_as('sso_link_admin');

SELECT throws_ok(
  $$ SELECT 1 FROM public.sso_provider_org_links $$,
  '42501',
  NULL,
  'super admins cannot read links through PostgREST'
);

SELECT throws_ok(
  $$
    DELETE FROM public.sso_provider_org_links
    WHERE org_id = '78000000-0000-4000-8000-000000000002'
  $$,
  '42501',
  NULL,
  'super admins cannot delete links through PostgREST'
);

SELECT tests.authenticate_as_service_role();

DELETE FROM public.sso_providers WHERE id = '78000000-0000-4000-8000-0000000000aa';

SELECT is_empty(
  $$ SELECT 1 FROM public.sso_provider_org_links WHERE sso_provider_id = '78000000-0000-4000-8000-0000000000aa' $$,
  'deleting the provider removes its links'
);

SELECT tests.authenticate_as('sso_link_admin');

SELECT throws_ok(
  $$
    INSERT INTO public.sso_provider_org_links (sso_provider_id, org_id)
    VALUES (gen_random_uuid(), '78000000-0000-4000-8000-000000000002')
  $$,
  '42501',
  NULL,
  'super admins cannot create links through PostgREST'
);

SELECT * FROM finish();

ROLLBACK;
