-- Bind direct RBAC user checks to the calling session.
--
-- rbac_check_permission_direct and rbac_check_permission_direct_no_password_policy
-- take an explicit p_user_id and stay EXECUTE-able by `authenticated` because the
-- console resolves other org members' permissions (userHasPermission in
-- src/services/permissions.ts). Until now the user path trusted p_user_id
-- blindly, so a signed-in session could evaluate permissions (and the 2FA /
-- password-policy gates) for any user in any org.
--
-- 1) New internal helper rbac_caller_can_check_user_permission(target, org):
--    - internal roles (service_role / postgres / backend DB users): allowed;
--    - no end-user JWT (auth.uid() IS NULL): allowed. Direct PostgREST EXECUTE
--      is not granted to anon, so this only covers nested SECURITY DEFINER
--      callers resolving an API-key owner (e.g. get_orgs_v7, cli helpers);
--    - checking yourself: allowed;
--    - checking someone else: the caller must hold org.read on the resolved
--      target org (same rule as get_org_user_access_rbac), evaluated with the
--      same password-policy mode as the calling checker. Org-less scopes are
--      denied for other users.
-- 2) The user path of both direct checkers calls the helper before any 2FA,
--    password-policy or role evaluation and returns false when it denies.
--    The API-key path is unchanged (it already requires the key itself and
--    rejects a p_user_id that is not the key owner).
-- 3) is_user_org_admin / is_user_app_admin take an arbitrary user id, have no
--    console, CLI, backend, RLS or SQL callers, and were EXECUTE-able by
--    `authenticated`. Restrict them to service_role.

CREATE OR REPLACE FUNCTION public.rbac_caller_can_check_user_permission(
  p_target_user_id uuid,
  p_org_id uuid,
  p_skip_password_policy boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
BEGIN
  IF public.is_internal_request_role(public.current_request_role()) THEN
    RETURN true;
  END IF;

  IF v_caller_id IS NULL THEN
    RETURN true;
  END IF;

  IF p_target_user_id IS NULL OR p_target_user_id = v_caller_id THEN
    RETURN true;
  END IF;

  IF p_org_id IS NULL THEN
    RETURN false;
  END IF;

  -- Use the same gate mode as the checker that called us, so the
  -- no-password-policy variant does not become password-gated here.
  IF p_skip_password_policy THEN
    RETURN public.rbac_check_permission_direct_no_password_policy(
      public.rbac_perm_org_read(),
      v_caller_id,
      p_org_id,
      NULL::character varying,
      NULL::bigint,
      NULL::text
    );
  END IF;

  RETURN public.rbac_check_permission_direct(
    public.rbac_perm_org_read(),
    v_caller_id,
    p_org_id,
    NULL::character varying,
    NULL::bigint,
    NULL::text
  );
END;
$$;

ALTER FUNCTION public.rbac_caller_can_check_user_permission(uuid, uuid, boolean) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.rbac_caller_can_check_user_permission(uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rbac_caller_can_check_user_permission(uuid, uuid, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.rbac_caller_can_check_user_permission(uuid, uuid, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.rbac_caller_can_check_user_permission(uuid, uuid, boolean) TO service_role;

COMMENT ON FUNCTION public.rbac_caller_can_check_user_permission(uuid, uuid, boolean) IS
  'Internal guard for direct RBAC user checks. True for internal roles, sessions without an end-user JWT, and self checks; otherwise the JWT caller must hold org.read on the target org.';

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

  -- A JWT session may only inspect another user's permissions inside an org
  -- it can read. Runs before the 2FA / password gates so nothing leaks.
  IF NOT public.rbac_caller_can_check_user_permission(v_effective_user_id, v_effective_org_id) THEN
    RETURN false;
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

COMMENT ON FUNCTION public.rbac_check_permission_direct(
  text, uuid, uuid, character varying, bigint, text
) IS 'Direct RBAC permission check. Non-empty p_apikey selects the API-key principal unless it is only the request capgkey while JWT auth.uid() matches p_user_id (prefer JWT). A JWT caller checking another user must hold org.read on the target org. Applies channel overrides and password/2FA for users. RLS should use rbac_check_permission_request.';

CREATE OR REPLACE FUNCTION public.rbac_check_permission_direct_no_password_policy(
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
  v_effective_org_id uuid;
  v_effective_user_id uuid := p_user_id;
  v_effective_app_id character varying;
  v_api_key public.apikeys%ROWTYPE;
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

    RETURN public.rbac_has_permission(
      public.rbac_principal_apikey(),
      v_api_key.rbac_id,
      p_permission_key,
      v_effective_org_id,
      v_effective_app_id,
      p_channel_id
    );
  END IF;

  -- A JWT session may only inspect another user's permissions inside an org
  -- it can read. Runs before the 2FA gate so nothing leaks.
  IF NOT public.rbac_caller_can_check_user_permission(v_effective_user_id, v_effective_org_id, true) THEN
    RETURN false;
  END IF;

  IF v_effective_org_id IS NOT NULL THEN
    IF (SELECT enforcing_2fa FROM public.orgs WHERE id = v_effective_org_id)
      AND (v_effective_user_id IS NULL OR NOT public.has_2fa_enabled(v_effective_user_id))
    THEN
      RETURN false;
    END IF;
  END IF;

  IF v_effective_user_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN public.rbac_has_permission(
    public.rbac_principal_user(),
    v_effective_user_id,
    p_permission_key,
    v_effective_org_id,
    v_effective_app_id,
    p_channel_id
  );
END;
$$;

COMMENT ON FUNCTION public.rbac_check_permission_direct_no_password_policy(
  text, uuid, uuid, character varying, bigint, text
) IS 'Same as rbac_check_permission_direct but skips the password-policy gate. Non-empty p_apikey selects the API-key principal unless it is only the request capgkey while JWT auth.uid() matches p_user_id. A JWT caller checking another user must hold org.read on the target org.';

-- Arbitrary-user admin probes: no client or SQL callers, keep them internal.
REVOKE ALL ON FUNCTION public.is_user_org_admin(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_user_org_admin(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.is_user_org_admin(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.is_user_org_admin(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.is_user_app_admin(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_user_app_admin(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.is_user_app_admin(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.is_user_app_admin(uuid, uuid) TO service_role;
