-- app.manage_apikeys: create, update and delete API keys whose bindings are
-- limited to this app (app/channel scope). Granted to app_admin so app owners
-- (including org_members who created their app) can issue keys for their own
-- apps without the org-wide org.manage_apikeys. Keys stay capped by the
-- creator's own permissions (see createRoleBindingForPrincipal).
-- org_admin and org_super_admin hold every app permission at org scope, so
-- they get it too for consistency.

CREATE OR REPLACE FUNCTION public.rbac_perm_app_manage_apikeys() RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$ SELECT 'app.manage_apikeys'::text $$;

ALTER FUNCTION public.rbac_perm_app_manage_apikeys() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.rbac_perm_app_manage_apikeys() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rbac_perm_app_manage_apikeys() TO anon, authenticated, service_role;

INSERT INTO public.permissions (key, scope_type, description)
VALUES (
  public.rbac_perm_app_manage_apikeys(),
  public.rbac_scope_app(),
  'Create, update and delete API keys limited to this app'
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.key = public.rbac_perm_app_manage_apikeys()
WHERE r.name IN (public.rbac_role_app_admin(), public.rbac_role_org_admin(), public.rbac_role_org_super_admin())
ON CONFLICT DO NOTHING;
