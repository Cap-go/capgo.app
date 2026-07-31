BEGIN;

SELECT plan(2);

SELECT tests.create_supabase_user('rbac_apikey_mismatch_admin', 'rbac_apikey_mismatch_admin@test.local');
SELECT tests.create_supabase_user('rbac_apikey_mismatch_actor', 'rbac_apikey_mismatch_actor@test.local');
SELECT tests.create_supabase_user('rbac_apikey_mismatch_key_owner', 'rbac_apikey_mismatch_key_owner@test.local');

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES
  (tests.get_supabase_uid('rbac_apikey_mismatch_admin'), 'rbac_apikey_mismatch_admin@test.local', NOW(), NOW()),
  (tests.get_supabase_uid('rbac_apikey_mismatch_actor'), 'rbac_apikey_mismatch_actor@test.local', NOW(), NOW()),
  (tests.get_supabase_uid('rbac_apikey_mismatch_key_owner'), 'rbac_apikey_mismatch_key_owner@test.local', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES (
  '70000000-0000-4000-8000-000000000048',
  tests.get_supabase_uid('rbac_apikey_mismatch_admin'),
  'RBAC API key mismatch org',
  'rbac-apikey-mismatch@test.local'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.apikeys (id, user_id, key, name)
VALUES
  (45148, tests.get_supabase_uid('rbac_apikey_mismatch_key_owner'), 'rbac-apikey-mismatch-key', 'rbac-apikey-mismatch-key'),
  (45149, tests.get_supabase_uid('rbac_apikey_mismatch_actor'), 'rbac-apikey-mismatch-actor-key', 'rbac-apikey-mismatch-actor-key')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by)
SELECT
  public.rbac_principal_apikey(),
  ak.rbac_id,
  r.id,
  public.rbac_scope_org(),
  '70000000-0000-4000-8000-000000000048',
  tests.get_supabase_uid('rbac_apikey_mismatch_admin')
FROM public.roles r
JOIN public.apikeys ak
  ON ak.id IN (45148, 45149)
WHERE r.name = public.rbac_role_org_super_admin()
ON CONFLICT DO NOTHING;

SELECT ok(
  NOT public.rbac_check_permission_direct(
    public.rbac_perm_org_update_user_roles(),
    tests.get_supabase_uid('rbac_apikey_mismatch_actor'),
    '70000000-0000-4000-8000-000000000048',
    NULL::varchar,
    NULL::bigint,
    'rbac-apikey-mismatch-key'
  ),
  'rbac_check_permission_direct denies mismatched session user and API key owner'
);

SELECT ok(
  public.rbac_check_permission_direct(
    public.rbac_perm_org_update_user_roles(),
    tests.get_supabase_uid('rbac_apikey_mismatch_actor'),
    '70000000-0000-4000-8000-000000000048',
    NULL::varchar,
    NULL::bigint,
    'rbac-apikey-mismatch-actor-key'
  ),
  'rbac_check_permission_direct allows matching session user and API key owner'
);

SELECT * FROM finish();

ROLLBACK;
