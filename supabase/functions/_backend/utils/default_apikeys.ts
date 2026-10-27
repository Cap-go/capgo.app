/**
 * SQL used by createApiKey() to provision the three default API keys of a user
 * (`$1` = user id) together with their RBAC role bindings.
 *
 * Default keys run with the service connection, which bypasses the
 * caller-rank checks applied to user-initiated role bindings. The keys must
 * therefore never be granted more than their owner holds:
 *
 * - every candidate binding (key, role, scope) is kept only when the owner
 *   holds every permission of that role (including its role_hierarchy
 *   children) at the same org/app scope, checked with rbac_has_permission();
 * - "default org admin" gets org_admin only where the owner already has all
 *   org_admin permissions (org_admin / org_super_admin). In other orgs it
 *   mirrors the owner's own highest-priority org-scoped role instead;
 * - "default app uploader" / "default app reader" get org_member and
 *   app_uploader / app_reader only where the owner already has those rights;
 * - a binding never outlives the owner's own rights: when a permission of the
 *   role is only granted to the owner by expiring bindings, the key binding
 *   expires when the earliest such permission does.
 */
export const CREATE_DEFAULT_API_KEYS_SQL = `WITH RECURSIVE default_keys(name) AS (
  VALUES
    ('default org admin'),
    ('default app uploader'),
    ('default app reader')
),
inserted AS (
  INSERT INTO public.apikeys (
    user_id,
    key,
    key_hash,
    name
  )
  SELECT
    $1::uuid,
    gen_random_uuid()::text,
    NULL,
    default_key.name
  FROM default_keys AS default_key
  RETURNING user_id, rbac_id, name
),
current_orgs AS (
  SELECT DISTINCT rb.org_id
  FROM public.role_bindings rb
  WHERE rb.principal_type = public.rbac_principal_user()
    AND rb.principal_id = $1::uuid
    AND rb.org_id IS NOT NULL
    AND (rb.expires_at IS NULL OR rb.expires_at > now())

  UNION

  SELECT DISTINCT g.org_id
  FROM public.group_members gm
  INNER JOIN public.groups g ON g.id = gm.group_id
  INNER JOIN public.role_bindings rb
    ON rb.principal_type = public.rbac_principal_group()
    AND rb.principal_id = gm.group_id
    AND rb.org_id = g.org_id
  WHERE gm.user_id = $1::uuid
    AND rb.org_id IS NOT NULL
    AND (rb.expires_at IS NULL OR rb.expires_at > now())
),
owner_org_roles AS (
  SELECT rb.org_id, rb.role_id
  FROM public.role_bindings rb
  WHERE rb.principal_type = public.rbac_principal_user()
    AND rb.principal_id = $1::uuid
    AND rb.scope_type = public.rbac_scope_org()
    AND rb.org_id IS NOT NULL
    AND (rb.expires_at IS NULL OR rb.expires_at > now())

  UNION

  SELECT rb.org_id, rb.role_id
  FROM public.group_members gm
  INNER JOIN public.groups g ON g.id = gm.group_id
  INNER JOIN public.role_bindings rb
    ON rb.principal_type = public.rbac_principal_group()
    AND rb.principal_id = gm.group_id
    AND rb.org_id = g.org_id
  WHERE gm.user_id = $1::uuid
    AND rb.scope_type = public.rbac_scope_org()
    AND rb.org_id IS NOT NULL
    AND (rb.expires_at IS NULL OR rb.expires_at > now())
),
owner_bindings AS (
  SELECT rb.org_id, rb.scope_type, rb.app_id, rb.role_id, rb.expires_at
  FROM public.role_bindings rb
  WHERE rb.principal_type = public.rbac_principal_user()
    AND rb.principal_id = $1::uuid
    AND rb.org_id IS NOT NULL
    AND (rb.expires_at IS NULL OR rb.expires_at > now())

  UNION ALL

  SELECT rb.org_id, rb.scope_type, rb.app_id, rb.role_id, rb.expires_at
  FROM public.group_members gm
  INNER JOIN public.groups g ON g.id = gm.group_id
  INNER JOIN public.role_bindings rb
    ON rb.principal_type = public.rbac_principal_group()
    AND rb.principal_id = gm.group_id
    AND rb.org_id = g.org_id
  WHERE gm.user_id = $1::uuid
    AND rb.org_id IS NOT NULL
    AND (rb.expires_at IS NULL OR rb.expires_at > now())
),
base_candidates AS (
  SELECT
    candidate.name,
    roles.id AS role_id,
    roles.scope_type,
    current_orgs.org_id,
    NULL::uuid AS app_uuid,
    NULL::varchar AS app_identifier
  FROM (
    VALUES
      ('default org admin', public.rbac_role_org_admin()),
      ('default app uploader', public.rbac_role_org_member()),
      ('default app reader', public.rbac_role_org_member())
  ) AS candidate(name, role_name)
  CROSS JOIN current_orgs
  JOIN public.roles roles
    ON roles.name = candidate.role_name
    AND roles.scope_type = public.rbac_scope_org()

  UNION ALL

  SELECT
    candidate.name,
    roles.id,
    roles.scope_type,
    apps.owner_org,
    apps.id,
    apps.app_id
  FROM (
    VALUES
      ('default app uploader', public.rbac_role_app_uploader()),
      ('default app reader', public.rbac_role_app_reader())
  ) AS candidate(name, role_name)
  CROSS JOIN current_orgs
  JOIN public.apps apps ON apps.owner_org = current_orgs.org_id
  JOIN public.roles roles
    ON roles.name = candidate.role_name
    AND roles.scope_type = public.rbac_scope_app()
),
candidate_roles AS (
  SELECT DISTINCT role_id, scope_type
  FROM base_candidates

  UNION

  SELECT DISTINCT owner_org_roles.role_id, public.rbac_scope_org()
  FROM owner_org_roles

  UNION

  SELECT DISTINCT owner_bindings.role_id, owner_bindings.scope_type
  FROM owner_bindings
  WHERE owner_bindings.scope_type IN (public.rbac_scope_org(), public.rbac_scope_app())
),
role_closure(root_role_id, scope_type, role_id) AS (
  SELECT candidate_roles.role_id, candidate_roles.scope_type, candidate_roles.role_id
  FROM candidate_roles

  UNION

  SELECT role_closure.root_role_id, role_closure.scope_type, hierarchy.child_role_id
  FROM role_closure
  JOIN public.role_hierarchy hierarchy
    ON hierarchy.parent_role_id = role_closure.role_id
  JOIN public.roles child_role
    ON child_role.id = hierarchy.child_role_id
    AND child_role.scope_type = role_closure.scope_type
),
role_permission_keys AS (
  SELECT DISTINCT role_closure.root_role_id, permissions.key
  FROM role_closure
  JOIN public.role_permissions role_permissions
    ON role_permissions.role_id = role_closure.role_id
  JOIN public.permissions permissions
    ON permissions.id = role_permissions.permission_id
),
owner_covered_candidates AS (
  SELECT base_candidates.*
  FROM base_candidates
  WHERE NOT EXISTS (
    SELECT 1
    FROM role_permission_keys
    WHERE role_permission_keys.root_role_id = base_candidates.role_id
      AND NOT public.rbac_has_permission(
        public.rbac_principal_user(),
        $1::uuid,
        role_permission_keys.key,
        base_candidates.org_id,
        base_candidates.app_identifier,
        NULL::bigint
      )
  )
),
mirrored_admin_candidates AS (
  -- Orgs where the owner is not an org admin: the admin key mirrors the
  -- owner's own org-scoped roles, never anything above them.
  -- One org-scoped binding per principal and org: keep the owner's
  -- highest-priority covered role.
  SELECT DISTINCT ON (owner_org_roles.org_id)
    'default org admin'::text AS name,
    owner_org_roles.role_id,
    public.rbac_scope_org() AS scope_type,
    owner_org_roles.org_id,
    NULL::uuid AS app_uuid,
    NULL::varchar AS app_identifier
  FROM owner_org_roles
  JOIN public.roles roles ON roles.id = owner_org_roles.role_id
  WHERE roles.scope_type = public.rbac_scope_org()
    AND roles.name <> public.rbac_role_org_super_admin()
    AND NOT EXISTS (
      SELECT 1
      FROM owner_covered_candidates
      WHERE owner_covered_candidates.name = 'default org admin'
        AND owner_covered_candidates.org_id = owner_org_roles.org_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM role_permission_keys
      WHERE role_permission_keys.root_role_id = owner_org_roles.role_id
        AND NOT public.rbac_has_permission(
          public.rbac_principal_user(),
          $1::uuid,
          role_permission_keys.key,
          owner_org_roles.org_id,
          NULL::varchar,
          NULL::bigint
        )
    )
  ORDER BY owner_org_roles.org_id, roles.priority_rank DESC, roles.name
),
allowed_bindings AS (
  SELECT name, role_id, scope_type, org_id, app_uuid FROM owner_covered_candidates
  UNION
  SELECT name, role_id, scope_type, org_id, app_uuid FROM mirrored_admin_candidates
)
INSERT INTO public.role_bindings (
  principal_type,
  principal_id,
  role_id,
  scope_type,
  org_id,
  app_id,
  expires_at,
  granted_by,
  reason,
  is_direct
)
SELECT
  public.rbac_principal_apikey(),
  inserted.rbac_id,
  allowed_bindings.role_id,
  allowed_bindings.scope_type,
  allowed_bindings.org_id,
  allowed_bindings.app_uuid,
  owner_expiry.expires_at,
  inserted.user_id,
  CASE
    WHEN allowed_bindings.scope_type = public.rbac_scope_app() THEN 'Default API key RBAC app binding'
    ELSE 'Default API key RBAC org binding'
  END,
  true
FROM inserted
JOIN allowed_bindings ON allowed_bindings.name = inserted.name
CROSS JOIN LATERAL (
  -- The owner keeps every permission of the role until the earliest moment
  -- one of them is no longer granted by any covering owner binding.
  SELECT min(permission_expiry.expires_at) AS expires_at
  FROM (
    SELECT
      CASE
        WHEN bool_or(owner_bindings.expires_at IS NULL) THEN NULL::timestamptz
        ELSE max(owner_bindings.expires_at)
      END AS expires_at
    FROM role_permission_keys AS key_permission
    JOIN owner_bindings
      ON owner_bindings.org_id = allowed_bindings.org_id
      AND (
        owner_bindings.scope_type = public.rbac_scope_org()
        OR (
          allowed_bindings.app_uuid IS NOT NULL
          AND owner_bindings.scope_type = public.rbac_scope_app()
          AND owner_bindings.app_id = allowed_bindings.app_uuid
        )
      )
    JOIN role_permission_keys AS owner_permission
      ON owner_permission.root_role_id = owner_bindings.role_id
      AND owner_permission.key = key_permission.key
    WHERE key_permission.root_role_id = allowed_bindings.role_id
    GROUP BY key_permission.key
  ) AS permission_expiry
) AS owner_expiry
ON CONFLICT DO NOTHING`
