BEGIN;

SELECT plan(5);

SELECT tests.create_supabase_user('get_org_apikeys_admin', 'get_org_apikeys_admin@test.local');
SELECT tests.create_supabase_user('get_org_apikeys_member', 'get_org_apikeys_member@test.local');
SELECT tests.create_supabase_user('get_org_apikeys_owner', 'get_org_apikeys_owner@test.local');
SELECT tests.create_supabase_user('get_org_apikeys_org_bound_owner', 'get_org_apikeys_org_bound_owner@test.local');
SELECT tests.create_supabase_user('get_org_apikeys_app_bound_owner', 'get_org_apikeys_app_bound_owner@test.local');

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES
  (tests.get_supabase_uid('get_org_apikeys_admin'), 'get_org_apikeys_admin@test.local', NOW(), NOW()),
  (tests.get_supabase_uid('get_org_apikeys_member'), 'get_org_apikeys_member@test.local', NOW(), NOW()),
  (tests.get_supabase_uid('get_org_apikeys_owner'), 'get_org_apikeys_owner@test.local', NOW(), NOW()),
  (tests.get_supabase_uid('get_org_apikeys_org_bound_owner'), 'get_org_apikeys_org_bound_owner@test.local', NOW(), NOW()),
  (tests.get_supabase_uid('get_org_apikeys_app_bound_owner'), 'get_org_apikeys_app_bound_owner@test.local', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES (
  '70000000-0000-4000-8000-000000000047',
  tests.get_supabase_uid('get_org_apikeys_admin'),
  'Get org apikeys permission org',
  'get-org-apikeys@test.local'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.apps (id, app_id, icon_url, user_id, name, owner_org)
VALUES (
  '70000000-0000-4000-8000-000000004701',
  'com.test.getorgapikeys.app',
  '',
  tests.get_supabase_uid('get_org_apikeys_admin'),
  'Get org apikeys app',
  '70000000-0000-4000-8000-000000000047'
)
ON CONFLICT (app_id) DO NOTHING;

INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by)
SELECT
  public.rbac_principal_user(),
  tests.get_supabase_uid('get_org_apikeys_admin'),
  r.id,
  public.rbac_scope_org(),
  '70000000-0000-4000-8000-000000000047',
  tests.get_supabase_uid('get_org_apikeys_admin')
FROM public.roles r
WHERE r.name = public.rbac_role_org_super_admin()
ON CONFLICT DO NOTHING;

INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by)
SELECT
  public.rbac_principal_user(),
  tests.get_supabase_uid('get_org_apikeys_member'),
  r.id,
  public.rbac_scope_org(),
  '70000000-0000-4000-8000-000000000047',
  tests.get_supabase_uid('get_org_apikeys_admin')
FROM public.roles r
WHERE r.name = public.rbac_role_org_member()
ON CONFLICT DO NOTHING;

INSERT INTO public.apikeys (id, user_id, key, name)
VALUES
  (45047, tests.get_supabase_uid('get_org_apikeys_owner'), 'get-org-apikeys-unbound-key', 'get-org-apikeys-unbound-key'),
  (45048, tests.get_supabase_uid('get_org_apikeys_org_bound_owner'), 'get-org-apikeys-org-bound-key', 'get-org-apikeys-org-bound-key'),
  (45049, tests.get_supabase_uid('get_org_apikeys_app_bound_owner'), 'get-org-apikeys-app-bound-key', 'get-org-apikeys-app-bound-key')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by)
SELECT
  public.rbac_principal_apikey(),
  ak.rbac_id,
  r.id,
  public.rbac_scope_org(),
  '70000000-0000-4000-8000-000000000047',
  tests.get_supabase_uid('get_org_apikeys_admin')
FROM public.roles r
JOIN public.apikeys ak
  ON ak.id = 45048
WHERE r.name = public.rbac_role_org_member()
ON CONFLICT DO NOTHING;

INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, app_id, granted_by)
SELECT
  public.rbac_principal_apikey(),
  ak.rbac_id,
  r.id,
  public.rbac_scope_app(),
  '70000000-0000-4000-8000-000000000047',
  '70000000-0000-4000-8000-000000004701'::uuid,
  tests.get_supabase_uid('get_org_apikeys_admin')
FROM public.roles r
JOIN public.apikeys ak
  ON ak.id = 45049
WHERE r.name = public.rbac_role_app_developer()
ON CONFLICT DO NOTHING;

SELECT tests.authenticate_as('get_org_apikeys_member');

SELECT throws_ok(
  $q$
    SELECT *
    FROM public.get_org_apikeys('70000000-0000-4000-8000-000000000047'::uuid);
  $q$,
  'NO_RIGHTS',
  'get_org_apikeys denies org members without org.update_user_roles permission'
);

SELECT tests.clear_authentication();
SELECT tests.authenticate_as('get_org_apikeys_admin');

SELECT ok(
  (
    SELECT COUNT(*)
    FROM public.get_org_apikeys('70000000-0000-4000-8000-000000000047'::uuid)
    WHERE id = 45047
  ) = 0,
  'get_org_apikeys does not enumerate unbound API keys from same owner org'
);

SELECT ok(
  (
    SELECT COUNT(*)
    FROM public.get_org_apikeys('70000000-0000-4000-8000-000000000047'::uuid)
    WHERE id = 45048
  ) = 1,
  'get_org_apikeys includes keys with direct apikey org bindings'
);

SELECT ok(
  (
    SELECT COUNT(*)
    FROM public.get_org_apikeys('70000000-0000-4000-8000-000000000047'::uuid)
    WHERE id = 45049
  ) = 1,
  'get_org_apikeys includes keys with direct apikey app bindings in the org'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.get_org_apikeys(uuid)'::regprocedure, 'EXECUTE'),
  'anon cannot execute get_org_apikeys'
);

SELECT tests.clear_authentication();

SELECT * FROM finish();

ROLLBACK;
