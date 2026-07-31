BEGIN;

SELECT plan(9);

-- org.manage_apikeys permission and apikey_manager role exist
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.permissions
    WHERE key = public.rbac_perm_org_manage_apikeys()
  ),
  'org.manage_apikeys permission exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.roles
    WHERE name = public.rbac_role_apikey_manager()
      AND scope_type = public.rbac_scope_org()
      AND is_assignable IS TRUE
  ),
  'apikey_manager role exists and is assignable'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.roles r
    INNER JOIN public.role_permissions rp ON rp.role_id = r.id
    INNER JOIN public.permissions p ON p.id = rp.permission_id
    WHERE r.name = public.rbac_role_org_super_admin()
      AND p.key = public.rbac_perm_org_manage_apikeys()
  ),
  'org_super_admin inherits org.manage_apikeys'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.roles r
    INNER JOIN public.role_permissions rp ON rp.role_id = r.id
    INNER JOIN public.permissions p ON p.id = rp.permission_id
    WHERE r.name = public.rbac_role_app_uploader()
      AND p.key = public.rbac_perm_channel_promote_bundle()
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.roles r
    INNER JOIN public.role_permissions rp ON rp.role_id = r.id
    INNER JOIN public.permissions p ON p.id = rp.permission_id
    WHERE r.name = public.rbac_role_app_uploader()
      AND p.key = public.rbac_perm_channel_update_settings()
  ),
  'app_uploader can promote bundles but cannot update channel settings'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.roles r
    INNER JOIN public.role_permissions rp ON rp.role_id = r.id
    INNER JOIN public.permissions p ON p.id = rp.permission_id
    WHERE r.name = 'channel_developer'
      AND p.key = public.rbac_perm_channel_promote_bundle()
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.roles r
    INNER JOIN public.role_permissions rp ON rp.role_id = r.id
    INNER JOIN public.permissions p ON p.id = rp.permission_id
    WHERE r.name = 'channel_developer'
      AND p.key = public.rbac_perm_channel_update_settings()
  ),
  'channel_developer can promote bundles without channel settings writes'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.roles r
    INNER JOIN public.role_permissions rp ON rp.role_id = r.id
    INNER JOIN public.permissions p ON p.id = rp.permission_id
    WHERE r.name = public.rbac_role_apikey_manager()
      AND p.key = public.rbac_perm_org_read()
  ),
  'apikey_manager inherits org.read for expiration policy enforcement'
);

-- Re-assert seeded apikey 113 binding before switching to an authenticated role.
DO $$
DECLARE
  v_rbac_id uuid;
  v_role_id uuid;
BEGIN
  SELECT ak.rbac_id
  INTO v_rbac_id
  FROM public.apikeys ak
  WHERE ak.id = 113;

  IF v_rbac_id IS NULL THEN
    RAISE EXCEPTION 'test setup: seeded apikey 113 is missing';
  END IF;

  SELECT roles.id
  INTO v_role_id
  FROM public.roles roles
  WHERE roles.name = public.rbac_role_apikey_manager()
    AND roles.scope_type = public.rbac_scope_org();

  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'test setup: apikey_manager role is missing';
  END IF;

  DELETE FROM public.role_bindings rb
  WHERE rb.principal_type = public.rbac_principal_apikey()
    AND rb.principal_id = v_rbac_id
    AND rb.scope_type = public.rbac_scope_org()
    AND rb.org_id = 'f1a2b3c4-d5e6-4f70-8a9b-0c1d2e3f4a50'::uuid;

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
  VALUES (
    public.rbac_principal_apikey(),
    v_rbac_id,
    v_role_id,
    public.rbac_scope_org(),
    'f1a2b3c4-d5e6-4f70-8a9b-0c1d2e3f4a50'::uuid,
    'd0f1a2b3-c4d5-4e6f-8a90-b1c2d3e4f506'::uuid,
    'test setup apikey management binding',
    true
  );
END $$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.apikeys ak
    JOIN public.role_bindings rb
      ON rb.principal_type = public.rbac_principal_apikey()
      AND rb.principal_id = ak.rbac_id
    JOIN public.roles r ON r.id = rb.role_id
    WHERE ak.id = 113
      AND r.name = public.rbac_role_apikey_manager()
  ),
  'seed apikey 113 is bound to apikey_manager'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.apikeys ak
    JOIN public.role_bindings rb
      ON rb.principal_type = public.rbac_principal_apikey()
      AND rb.principal_id = ak.rbac_id
    JOIN public.roles r ON r.id = rb.role_id
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE ak.id = 113
      AND p.key = public.rbac_perm_org_update_user_roles()
  ),
  'seed apikey 113 does not inherit org.update_user_roles'
);

-- API keys must not be blocked by org 2FA enforcement in direct RBAC checks
DO $$
DECLARE
  org_id uuid := gen_random_uuid();
  user_id uuid := tests.get_supabase_uid('test_admin');
  apikey_rbac_id uuid;
  apikey_value text := 'test-apikey-2fa-bypass-' || gen_random_uuid()::text;
BEGIN
  INSERT INTO public.orgs (id, created_by, name, management_email, enforcing_2fa)
  VALUES (org_id, user_id, 'API Key 2FA Bypass Org', 'apikey-2fa-bypass@capgo.app', true);

  INSERT INTO public.apikeys (user_id, key, name)
  VALUES (user_id, apikey_value, '2FA bypass test key')
  RETURNING rbac_id INTO apikey_rbac_id;

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
    public.rbac_principal_apikey(),
    apikey_rbac_id,
    roles.id,
    public.rbac_scope_org(),
    org_id,
    user_id,
    'test apikey org.read binding',
    true
  FROM public.roles
  WHERE roles.name = public.rbac_role_org_member()
  LIMIT 1;

  PERFORM set_config('test.apikey_2fa_bypass_org', org_id::text, true);
  PERFORM set_config('test.apikey_2fa_bypass_key', apikey_value, true);
END $$;

SELECT tests.authenticate_as('test_admin');

SELECT ok(
  public.rbac_check_permission_direct(
    public.rbac_perm_org_read(),
    tests.get_supabase_uid('test_admin'),
    current_setting('test.apikey_2fa_bypass_org')::uuid,
    NULL::character varying,
    NULL::bigint,
    current_setting('test.apikey_2fa_bypass_key')
  ),
  'API key direct RBAC check ignores org 2FA enforcement'
);

SELECT * FROM finish();

ROLLBACK;
