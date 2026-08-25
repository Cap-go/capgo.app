-- When a principal loses all role bindings in an org, stale channel_permission_overrides
-- must not keep granting channel-scoped permissions. Gate override application on an
-- active org binding (any scope) or group membership.
--
-- Execution profile for rbac_principal_has_org_binding (channel override gate):
-- - Called at most once per rbac_check_permission_direct when p_channel_id IS NOT NULL
--   (apikey and user branches are mutually exclusive).
-- - Roles: service_role only; invoked from SECURITY DEFINER rbac_check_permission_direct.
-- - Frequency: console/RLS channel-scoped checks; not plugin /updates|/stats hot path.
-- - Cardinality: role_bindings rows per (principal, org) are typically single-digit;
--   group_members per user is bounded by org group membership.
-- - Indexes: role_bindings_principal_org_idx (principal_type, principal_id, org_id,
--   expires_at); idx_group_members_user_id_group_id for group-derived user path;
--   groups PK for group-principal branch.
-- - Worst case (user + apikey call sites): Index Scan on role_bindings_principal_org_idx
--   with expires_at filter; Nested Loop from group_members (user_id) to role_bindings
--   (group principal). No sequential scan over role_bindings in EXPLAIN (ANALYZE,
--   BUFFERS) on local seed data.

CREATE OR REPLACE FUNCTION public.rbac_principal_has_org_binding(
  p_principal_type text,
  p_principal_id uuid,
  p_org_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_org_id IS NULL OR p_principal_id IS NULL OR p_principal_type IS NULL THEN false
    WHEN p_principal_type = public.rbac_principal_group() THEN EXISTS (
      SELECT 1
      FROM public.groups
      WHERE groups.id = p_principal_id
        AND groups.org_id = p_org_id
    )
    WHEN p_principal_type = public.rbac_principal_user() THEN (
      EXISTS (
        SELECT 1
        FROM public.role_bindings
        WHERE role_bindings.principal_type = p_principal_type
          AND role_bindings.principal_id = p_principal_id
          AND role_bindings.org_id = p_org_id
          AND (role_bindings.expires_at IS NULL OR role_bindings.expires_at > pg_catalog.now())
      )
      OR EXISTS (
        SELECT 1
        FROM public.group_members AS group_member
        INNER JOIN public.role_bindings AS group_binding
          ON group_binding.principal_type = public.rbac_principal_group()
          AND group_binding.principal_id = group_member.group_id
        WHERE group_member.user_id = p_principal_id
          AND group_binding.org_id = p_org_id
          AND (group_binding.expires_at IS NULL OR group_binding.expires_at > pg_catalog.now())
      )
    )
    ELSE EXISTS (
      SELECT 1
      FROM public.role_bindings
      WHERE role_bindings.principal_type = p_principal_type
        AND role_bindings.principal_id = p_principal_id
        AND role_bindings.org_id = p_org_id
        AND (role_bindings.expires_at IS NULL OR role_bindings.expires_at > pg_catalog.now())
    )
  END;
$$;

ALTER FUNCTION public.rbac_principal_has_org_binding(text, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.rbac_principal_has_org_binding(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rbac_principal_has_org_binding(text, uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.rbac_principal_has_org_binding(text, uuid, uuid) IS
  'True when the principal still has a non-expired role binding in the org (direct or via group membership for users) or the group belongs to the org. Called once per channel-scoped rbac_check_permission_direct (console/RLS only). Indexed lookups on role_bindings_principal_org_idx and idx_group_members_user_id_group_id; no table scan on role_bindings at seed scale.';

CREATE INDEX IF NOT EXISTS role_bindings_principal_org_idx
  ON public.role_bindings (principal_type, principal_id, org_id, expires_at);

CREATE OR REPLACE FUNCTION public.rbac_check_permission_direct(
  p_permission_key text,
  p_user_id uuid,
  p_org_id uuid,
  p_app_id character varying,
  p_channel_id bigint,
  p_apikey text DEFAULT NULL::text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_allowed boolean := false;
  v_effective_org_id uuid;
  v_effective_user_id uuid := p_user_id;
  v_effective_app_id character varying;
  v_api_key public.apikeys%ROWTYPE;
  v_channel_scope boolean := p_channel_id IS NOT NULL;
  v_override boolean;
  v_scope_ok boolean;
  v_use_apikey boolean;
  v_request_apikey text := NULLIF(btrim(p_apikey), '');
BEGIN
  IF p_permission_key IS NULL OR p_permission_key = '' THEN
    RETURN false;
  END IF;

  SELECT s.ok, s.effective_org_id, s.effective_app_id
  INTO v_scope_ok, v_effective_org_id, v_effective_app_id
  FROM public.rbac_resolve_permission_scope(p_org_id, p_app_id, p_channel_id) AS s;

  IF NOT COALESCE(v_scope_ok, false) THEN
    RETURN false;
  END IF;

  v_use_apikey := public.rbac_should_use_apikey_principal(p_user_id, p_apikey);

  IF v_use_apikey THEN
    SELECT * INTO v_api_key
    FROM public.find_apikey_by_value(v_request_apikey)
    LIMIT 1;

    IF v_api_key.id IS NULL
      OR (p_user_id IS NOT NULL AND p_user_id IS DISTINCT FROM v_api_key.user_id)
      OR v_effective_org_id IS NULL
    THEN
      RETURN false;
    END IF;

    IF public.is_apikey_expired(v_api_key.expires_at) THEN
      RETURN false;
    END IF;

    v_effective_user_id := v_api_key.user_id;

    v_allowed := public.rbac_has_permission(
      public.rbac_principal_apikey(),
      v_api_key.rbac_id,
      p_permission_key,
      v_effective_org_id,
      v_effective_app_id,
      p_channel_id
    );

    IF v_channel_scope
      AND public.rbac_principal_has_org_binding(
        public.rbac_principal_apikey(),
        v_api_key.rbac_id,
        v_effective_org_id
      )
    THEN
      SELECT o.is_allowed INTO v_override
      FROM public.channel_permission_overrides o
      WHERE o.principal_type = public.rbac_principal_apikey()
        AND o.principal_id = v_api_key.rbac_id
        AND o.channel_id = p_channel_id
        AND o.permission_key = p_permission_key
      LIMIT 1;

      IF v_override IS NOT NULL THEN
        v_allowed := v_override;
      END IF;
    END IF;

    RETURN v_allowed;
  END IF;

  IF v_effective_org_id IS NOT NULL THEN
    IF (SELECT enforcing_2fa FROM public.orgs WHERE id = v_effective_org_id)
      AND (v_effective_user_id IS NULL OR NOT public.has_2fa_enabled(v_effective_user_id))
    THEN
      RETURN false;
    END IF;

    IF public.user_meets_password_policy(v_effective_user_id, v_effective_org_id) = false THEN
      RETURN false;
    END IF;
  END IF;

  IF v_effective_user_id IS NULL THEN
    RETURN false;
  END IF;

  v_allowed := public.rbac_has_permission(
    public.rbac_principal_user(),
    v_effective_user_id,
    p_permission_key,
    v_effective_org_id,
    v_effective_app_id,
    p_channel_id
  );

  IF v_channel_scope
    AND public.rbac_principal_has_org_binding(
      public.rbac_principal_user(),
      v_effective_user_id,
      v_effective_org_id
    )
  THEN
    SELECT o.is_allowed INTO v_override
    FROM public.channel_permission_overrides o
    WHERE o.principal_type = public.rbac_principal_user()
      AND o.principal_id = v_effective_user_id
      AND o.channel_id = p_channel_id
      AND o.permission_key = p_permission_key
    LIMIT 1;

    IF v_override IS NOT NULL THEN
      v_allowed := v_override;
    END IF;
  END IF;

  RETURN v_allowed;
END;
$$;
