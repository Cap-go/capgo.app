-- Default API keys are provisioned by the backend with the service
-- connection. Earlier provisioning bound them to fixed roles in every org the
-- owner had any binding in, so a key could hold more than its owner (for
-- example org_admin in an org where the owner is only org_member).
--
-- Provisioning now keeps a binding only when the owner holds every permission
-- of the bound role at the same scope. Apply the same check to existing
-- default-key bindings (identified by the reason provisioning always writes):
-- remove the ones that exceed the owner's rights and replace excessive
-- org_admin bindings with the owner's own highest-priority org role in that
-- org, so the key keeps the access its owner legitimately has.

CREATE TEMP TABLE default_apikey_excessive_bindings AS
WITH default_key_bindings AS (
  SELECT
    role_bindings.id AS binding_id,
    role_bindings.principal_id,
    role_bindings.role_id,
    role_bindings.scope_type,
    role_bindings.org_id,
    apps.app_id AS app_identifier,
    apikeys.user_id
  FROM public.role_bindings
  INNER JOIN public.apikeys
    ON apikeys.rbac_id = role_bindings.principal_id
  LEFT JOIN public.apps
    ON apps.id = role_bindings.app_id
  WHERE role_bindings.principal_type = public.rbac_principal_apikey()
    AND role_bindings.reason IN (
      'Default API key RBAC org binding',
      'Default API key RBAC app binding'
    )
    AND role_bindings.org_id IS NOT NULL
    -- Owners who are org admins already hold every role the default keys get.
    AND NOT EXISTS (
      SELECT 1
      FROM public.role_bindings AS owner_binding
      INNER JOIN public.roles AS owner_role
        ON owner_role.id = owner_binding.role_id
      WHERE owner_binding.principal_type = public.rbac_principal_user()
        AND owner_binding.principal_id = apikeys.user_id
        AND owner_binding.scope_type = public.rbac_scope_org()
        AND owner_binding.org_id = role_bindings.org_id
        AND owner_role.name IN (
          public.rbac_role_org_super_admin(),
          public.rbac_role_org_admin()
        )
        AND (owner_binding.expires_at IS NULL OR owner_binding.expires_at > pg_catalog.now())
    )
),
role_closure AS (
  WITH RECURSIVE closure(root_role_id, scope_type, role_id) AS (
    SELECT DISTINCT default_key_bindings.role_id, default_key_bindings.scope_type, default_key_bindings.role_id
    FROM default_key_bindings

    UNION

    SELECT closure.root_role_id, closure.scope_type, hierarchy.child_role_id
    FROM closure
    INNER JOIN public.role_hierarchy AS hierarchy
      ON hierarchy.parent_role_id = closure.role_id
    INNER JOIN public.roles AS child_role
      ON child_role.id = hierarchy.child_role_id
      AND child_role.scope_type = closure.scope_type
  )
  SELECT root_role_id, role_id FROM closure
),
role_permission_keys AS (
  SELECT DISTINCT role_closure.root_role_id, permissions.key
  FROM role_closure
  INNER JOIN public.role_permissions
    ON role_permissions.role_id = role_closure.role_id
  INNER JOIN public.permissions
    ON permissions.id = role_permissions.permission_id
)
SELECT
  default_key_bindings.binding_id,
  default_key_bindings.principal_id,
  default_key_bindings.scope_type,
  default_key_bindings.org_id,
  default_key_bindings.user_id,
  excessive_role.name AS role_name
FROM default_key_bindings
INNER JOIN public.roles AS excessive_role
  ON excessive_role.id = default_key_bindings.role_id
WHERE EXISTS (
  SELECT 1
  FROM role_permission_keys
  WHERE role_permission_keys.root_role_id = default_key_bindings.role_id
    AND NOT public.rbac_has_permission(
      public.rbac_principal_user(),
      default_key_bindings.user_id,
      role_permission_keys.key,
      default_key_bindings.org_id,
      default_key_bindings.app_identifier,
      NULL::bigint
    )
);

DELETE FROM public.role_bindings
USING default_apikey_excessive_bindings AS excessive
WHERE role_bindings.id = excessive.binding_id;

-- Downgrade removed org_admin bindings (the default admin key) to the owner's
-- own org role there, matching what provisioning now grants.
INSERT INTO public.role_bindings (
  principal_type,
  principal_id,
  role_id,
  scope_type,
  org_id,
  expires_at,
  granted_by,
  reason,
  is_direct
)
SELECT DISTINCT ON (excessive.principal_id, excessive.org_id)
  public.rbac_principal_apikey(),
  excessive.principal_id,
  owner_role.role_id,
  public.rbac_scope_org(),
  excessive.org_id,
  owner_role.expires_at,
  excessive.user_id,
  'Default API key RBAC org binding',
  true
FROM default_apikey_excessive_bindings AS excessive
INNER JOIN (
  SELECT owner_binding.principal_id AS user_id, owner_binding.org_id, owner_binding.role_id, owner_binding.expires_at
  FROM public.role_bindings AS owner_binding
  WHERE owner_binding.principal_type = public.rbac_principal_user()
    AND owner_binding.scope_type = public.rbac_scope_org()
    AND (owner_binding.expires_at IS NULL OR owner_binding.expires_at > pg_catalog.now())

  UNION ALL

  SELECT group_member.user_id, group_binding.org_id, group_binding.role_id, group_binding.expires_at
  FROM public.group_members AS group_member
  INNER JOIN public.groups AS member_group
    ON member_group.id = group_member.group_id
  INNER JOIN public.role_bindings AS group_binding
    ON group_binding.principal_type = public.rbac_principal_group()
    AND group_binding.principal_id = group_member.group_id
    AND group_binding.org_id = member_group.org_id
  WHERE group_binding.scope_type = public.rbac_scope_org()
    AND (group_binding.expires_at IS NULL OR group_binding.expires_at > pg_catalog.now())
) AS owner_role
  ON owner_role.user_id = excessive.user_id
  AND owner_role.org_id = excessive.org_id
INNER JOIN public.roles AS roles
  ON roles.id = owner_role.role_id
  AND roles.scope_type = public.rbac_scope_org()
INNER JOIN public.apikeys AS key_row
  ON key_row.rbac_id = excessive.principal_id
INNER JOIN public.orgs AS org_row
  ON org_row.id = excessive.org_id
WHERE excessive.scope_type = public.rbac_scope_org()
  AND excessive.role_name = public.rbac_role_org_admin()
  AND roles.name <> public.rbac_role_org_super_admin()
  -- Skip keys that no longer satisfy the org's API-key expiration policy
  -- (enforced by role_bindings_enforce_apikey_expiration_policy); they only
  -- lose the excessive binding.
  AND NOT (org_row.require_apikey_expiration AND key_row.expires_at IS NULL)
  AND NOT (
    org_row.max_apikey_expiration_days IS NOT NULL
    AND key_row.expires_at IS NOT NULL
    AND key_row.expires_at > pg_catalog.clock_timestamp() + pg_catalog.make_interval(days => org_row.max_apikey_expiration_days)
  )
ORDER BY excessive.principal_id, excessive.org_id, roles.priority_rank DESC, roles.name
ON CONFLICT DO NOTHING;

DROP TABLE default_apikey_excessive_bindings;
