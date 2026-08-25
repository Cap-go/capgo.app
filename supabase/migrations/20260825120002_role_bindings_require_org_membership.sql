-- GHSA-9976-934w-5whq
-- role_bindings INSERT/UPDATE only checked that the caller has *_update_user_roles.
-- Direct PostgREST could grant app/channel/bundle roles to non-members.
-- Keep caller permission checks. Require the TARGET principal to belong to the org
-- for scoped bindings. Do not block org-scope user INSERT (first membership).

-- Execution model (RLS helper, not a user-facing RPC):
-- - Where: role_bindings INSERT WITH CHECK and UPDATE USING/WITH CHECK.
-- - How often: once per written row from authenticated callers.
-- - Roles: EXECUTE granted to authenticated for policy evaluation only; helper
--   lives in rbac_internal (not PostgREST-exposed).
-- - Cardinality: bounded indexed lookups on principal_id + org_id; never scans
--   all role_bindings/apps/orgs.
-- - Indexes: role_bindings_org_scope_uniq, role_bindings_principal_scope_idx,
--   groups_pkey, apikeys_rbac_id_key.

CREATE SCHEMA IF NOT EXISTS rbac_internal;

CREATE OR REPLACE FUNCTION rbac_internal.role_binding_principal_allowed_for_org(
  p_principal_type text,
  p_principal_id uuid,
  p_org_id uuid,
  p_scope_type text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_principal_type = public.rbac_principal_user()
      AND p_scope_type = public.rbac_scope_org()
    THEN true
    WHEN p_principal_type = public.rbac_principal_user()
      AND p_scope_type IN (
        public.rbac_scope_app(),
        public.rbac_scope_channel(),
        public.rbac_scope_bundle()
      )
    THEN EXISTS (
      SELECT 1
      FROM public.role_bindings AS membership
      WHERE membership.principal_type = public.rbac_principal_user()
        AND membership.principal_id = p_principal_id
        AND membership.scope_type = public.rbac_scope_org()
        AND membership.org_id = p_org_id
        AND (
          membership.expires_at IS NULL
          OR membership.expires_at > pg_catalog.now()
        )
    )
    WHEN p_principal_type = public.rbac_principal_group()
    THEN EXISTS (
      SELECT 1
      FROM public.groups
      WHERE groups.id = p_principal_id
        AND groups.org_id = p_org_id
    )
    WHEN p_principal_type = public.rbac_principal_apikey()
    THEN EXISTS (
      SELECT 1
      FROM public.role_bindings AS membership
      WHERE membership.principal_type = public.rbac_principal_apikey()
        AND membership.principal_id = p_principal_id
        AND membership.scope_type = public.rbac_scope_org()
        AND membership.org_id = p_org_id
        AND (
          membership.expires_at IS NULL
          OR membership.expires_at > pg_catalog.now()
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.apikeys
      WHERE apikeys.rbac_id = p_principal_id
        AND EXISTS (
          SELECT 1
          FROM public.role_bindings AS owner_membership
          WHERE owner_membership.principal_type = public.rbac_principal_user()
            AND owner_membership.principal_id = apikeys.user_id
            AND owner_membership.scope_type = public.rbac_scope_org()
            AND owner_membership.org_id = p_org_id
            AND (
              owner_membership.expires_at IS NULL
              OR owner_membership.expires_at > pg_catalog.now()
            )
        )
    )
    ELSE false
  END
$$;

ALTER FUNCTION rbac_internal.role_binding_principal_allowed_for_org(text, uuid, uuid, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION rbac_internal.role_binding_principal_allowed_for_org(text, uuid, uuid, text)
  FROM PUBLIC;
GRANT USAGE ON SCHEMA rbac_internal TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION rbac_internal.role_binding_principal_allowed_for_org(text, uuid, uuid, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION rbac_internal.role_binding_principal_allowed_for_org(text, uuid, uuid, text) IS
  'RLS helper: target principal may receive a role_binding on this org. User '
  'org-scope is always allowed (first membership). User app/channel/bundle '
  'requires a non-expired org-scope binding. Group must belong to the org. '
  'Apikey must have an org-scope binding or an owner with org-scope membership.';

DROP FUNCTION IF EXISTS public.role_binding_principal_allowed_for_org(text, uuid, uuid, text);

DROP POLICY IF EXISTS "role_bindings_insert" ON public.role_bindings;
CREATE POLICY "role_bindings_insert"
ON public.role_bindings
FOR INSERT
TO authenticated
WITH CHECK (
  (
    (
      scope_type = public.rbac_scope_org()
      AND public.rbac_check_permission_request(
        public.rbac_perm_org_update_user_roles(),
        org_id,
        NULL::character varying,
        NULL::bigint
      )
    )
    OR (
      scope_type = public.rbac_scope_app()
      AND EXISTS (
        SELECT 1
        FROM public.apps
        WHERE apps.id = role_bindings.app_id
          AND role_bindings.org_id = apps.owner_org
          AND public.rbac_check_permission_request(
            public.rbac_perm_app_update_user_roles(),
            apps.owner_org,
            apps.app_id,
            NULL::bigint
          )
      )
    )
    OR (
      scope_type = public.rbac_scope_channel()
      AND EXISTS (
        SELECT 1
        FROM public.channels
        WHERE channels.rbac_id = role_bindings.channel_id
          AND role_bindings.org_id = channels.owner_org
          AND public.rbac_check_permission_request(
            public.rbac_perm_app_update_user_roles(),
            channels.owner_org,
            channels.app_id,
            channels.id
          )
      )
    )
    OR (
      scope_type = public.rbac_scope_bundle()
      AND EXISTS (
        SELECT 1
        FROM public.app_versions
        JOIN public.apps
          ON apps.app_id = app_versions.app_id
        WHERE app_versions.id = role_bindings.bundle_id
          AND role_bindings.org_id = apps.owner_org
          AND public.rbac_check_permission_request(
            public.rbac_perm_app_update_user_roles(),
            apps.owner_org,
            apps.app_id,
            NULL::bigint
          )
      )
    )
  )
  AND rbac_internal.role_binding_principal_allowed_for_org(
    principal_type,
    principal_id,
    org_id,
    scope_type
  )
);

DROP POLICY IF EXISTS "role_bindings_update" ON public.role_bindings;
CREATE POLICY "role_bindings_update"
ON public.role_bindings
FOR UPDATE
TO authenticated
USING (
  (
    (
      scope_type = public.rbac_scope_org()
      AND public.rbac_check_permission_request(
        public.rbac_perm_org_update_user_roles(),
        org_id,
        NULL::character varying,
        NULL::bigint
      )
    )
    OR (
      scope_type = public.rbac_scope_app()
      AND EXISTS (
        SELECT 1
        FROM public.apps
        WHERE apps.id = role_bindings.app_id
          AND role_bindings.org_id = apps.owner_org
          AND public.rbac_check_permission_request(
            public.rbac_perm_app_update_user_roles(),
            apps.owner_org,
            apps.app_id,
            NULL::bigint
          )
      )
    )
    OR (
      scope_type = public.rbac_scope_channel()
      AND EXISTS (
        SELECT 1
        FROM public.channels
        WHERE channels.rbac_id = role_bindings.channel_id
          AND role_bindings.org_id = channels.owner_org
          AND public.rbac_check_permission_request(
            public.rbac_perm_app_update_user_roles(),
            channels.owner_org,
            channels.app_id,
            channels.id
          )
      )
    )
    OR (
      scope_type = public.rbac_scope_bundle()
      AND EXISTS (
        SELECT 1
        FROM public.app_versions
        JOIN public.apps
          ON apps.app_id = app_versions.app_id
        WHERE app_versions.id = role_bindings.bundle_id
          AND role_bindings.org_id = apps.owner_org
          AND public.rbac_check_permission_request(
            public.rbac_perm_app_update_user_roles(),
            apps.owner_org,
            apps.app_id,
            NULL::bigint
          )
      )
    )
  )
  AND rbac_internal.role_binding_principal_allowed_for_org(
    principal_type,
    principal_id,
    org_id,
    scope_type
  )
)
WITH CHECK (
  (
    (
      scope_type = public.rbac_scope_org()
      AND public.rbac_check_permission_request(
        public.rbac_perm_org_update_user_roles(),
        org_id,
        NULL::character varying,
        NULL::bigint
      )
    )
    OR (
      scope_type = public.rbac_scope_app()
      AND EXISTS (
        SELECT 1
        FROM public.apps
        WHERE apps.id = role_bindings.app_id
          AND role_bindings.org_id = apps.owner_org
          AND public.rbac_check_permission_request(
            public.rbac_perm_app_update_user_roles(),
            apps.owner_org,
            apps.app_id,
            NULL::bigint
          )
      )
    )
    OR (
      scope_type = public.rbac_scope_channel()
      AND EXISTS (
        SELECT 1
        FROM public.channels
        WHERE channels.rbac_id = role_bindings.channel_id
          AND role_bindings.org_id = channels.owner_org
          AND public.rbac_check_permission_request(
            public.rbac_perm_app_update_user_roles(),
            channels.owner_org,
            channels.app_id,
            channels.id
          )
      )
    )
    OR (
      scope_type = public.rbac_scope_bundle()
      AND EXISTS (
        SELECT 1
        FROM public.app_versions
        JOIN public.apps
          ON apps.app_id = app_versions.app_id
        WHERE app_versions.id = role_bindings.bundle_id
          AND role_bindings.org_id = apps.owner_org
          AND public.rbac_check_permission_request(
            public.rbac_perm_app_update_user_roles(),
            apps.owner_org,
            apps.app_id,
            NULL::bigint
          )
      )
    )
  )
  AND rbac_internal.role_binding_principal_allowed_for_org(
    principal_type,
    principal_id,
    org_id,
    scope_type
  )
);

COMMENT ON POLICY "role_bindings_insert" ON public.role_bindings IS
  'Caller needs *_update_user_roles. Scoped bindings require org_id to match the '
  'resource owner org and the target principal to belong to that org.';

COMMENT ON POLICY "role_bindings_update" ON public.role_bindings IS
  'Same caller permission, owner-org binding, and target-membership checks as '
  'role_bindings_insert.';
