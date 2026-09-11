-- rbac_check_permission_direct*: keep org 2FA and password-policy gates on the
-- user-principal branch only. Explicit API-key credentials bypass those gates
-- (compliance layer uses reject_access_due_to_2fa_for_app separately).

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
  v_allowed boolean := false;
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

    RETURN v_allowed;
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
