-- Shared app/channel scope resolution for the direct RBAC checkers.
-- Execution profile (RLS / hot console paths, not plugin /updates):
-- - Called once per rbac_check_permission_direct(_no_password_policy) invocation.
-- - Roles: authenticated + anon via SECURITY DEFINER owners; helper itself
--   granted only to service_role (callers are DEFINER).
-- - Lookups: optional apps by primary key app_id; optional channels by PK id.
-- - Cardinality: apps/channels are console-scale (thousands), not plugin-hot.
-- - Indexes: apps_pkey(app_id), channel_pkey(id) — Index Scan / Index Only Scan
--   in EXPLAIN (ANALYZE, BUFFERS) on local seed data.
CREATE OR REPLACE FUNCTION public.rbac_resolve_permission_scope(
  p_org_id uuid,
  p_app_id character varying,
  p_channel_id bigint
) RETURNS TABLE (
  ok boolean,
  effective_org_id uuid,
  effective_app_id character varying
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_app_owner_org uuid;
  v_channel_org_id uuid;
  v_channel_app_id character varying;
BEGIN
  effective_org_id := p_org_id;
  effective_app_id := p_app_id;

  IF p_app_id IS NOT NULL THEN
    SELECT owner_org INTO v_app_owner_org
    FROM public.apps
    WHERE app_id = p_app_id
    LIMIT 1;

    IF v_app_owner_org IS NULL THEN
      ok := false;
      RETURN NEXT;
      RETURN;
    END IF;

    IF effective_org_id IS NOT NULL AND effective_org_id IS DISTINCT FROM v_app_owner_org THEN
      ok := false;
      RETURN NEXT;
      RETURN;
    END IF;

    effective_org_id := v_app_owner_org;
  END IF;

  IF p_channel_id IS NOT NULL THEN
    SELECT owner_org, app_id
    INTO v_channel_org_id, v_channel_app_id
    FROM public.channels
    WHERE id = p_channel_id
    LIMIT 1;

    IF v_channel_org_id IS NULL THEN
      ok := false;
      RETURN NEXT;
      RETURN;
    END IF;

    IF effective_org_id IS NOT NULL AND effective_org_id IS DISTINCT FROM v_channel_org_id THEN
      ok := false;
      RETURN NEXT;
      RETURN;
    END IF;

    IF effective_app_id IS NOT NULL AND effective_app_id IS DISTINCT FROM v_channel_app_id THEN
      ok := false;
      RETURN NEXT;
      RETURN;
    END IF;

    effective_org_id := v_channel_org_id;
    effective_app_id := v_channel_app_id;
  END IF;

  ok := true;
  RETURN NEXT;
END;
$$;

ALTER FUNCTION public.rbac_resolve_permission_scope(uuid, character varying, bigint)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.rbac_resolve_permission_scope(uuid, character varying, bigint)
  FROM PUBLIC;
GRANT ALL ON FUNCTION public.rbac_resolve_permission_scope(uuid, character varying, bigint)
  TO service_role;

COMMENT ON FUNCTION public.rbac_resolve_permission_scope(uuid, character varying, bigint)
IS 'Resolves effective org/app scope for RBAC permission checks. '
   'Called once per direct permission check (RLS/console). '
   'Optional PK lookups on apps.app_id and channels.id '
   '(apps_pkey, channel_pkey). Returns ok=false on missing/conflicting scope.';

-- Shared JWT-vs-capgkey principal selection for both direct checkers.
CREATE OR REPLACE FUNCTION public.rbac_should_use_apikey_principal(
  p_user_id uuid,
  p_apikey text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_header_apikey text := NULLIF(btrim(public.get_apikey_header()), '');
  v_request_apikey text := NULLIF(btrim(p_apikey), '');
BEGIN
  -- Non-empty p_apikey selects the API-key principal, except when a JWT user is
  -- authenticated and p_apikey is only the request capgkey header forwarded by a
  -- DEFINER caller (same value as get_apikey_header). Prefer JWT in that case.
  RETURN v_request_apikey IS NOT NULL
    AND NOT (
      v_uid IS NOT NULL
      AND p_user_id IS NOT DISTINCT FROM v_uid
      AND v_request_apikey IS NOT DISTINCT FROM v_header_apikey
    );
END;
$$;

ALTER FUNCTION public.rbac_should_use_apikey_principal(uuid, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.rbac_should_use_apikey_principal(uuid, text)
  FROM PUBLIC;
GRANT ALL ON FUNCTION public.rbac_should_use_apikey_principal(uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.rbac_should_use_apikey_principal(uuid, text)
IS 'Returns true when direct RBAC checkers should evaluate the API-key principal. '
   'False when p_apikey is empty/null, or when JWT auth.uid() matches p_user_id and '
   'p_apikey equals the request capgkey header (prefer JWT).';

CREATE OR REPLACE FUNCTION public.rbac_check_permission_direct(
  p_permission_key text,
  p_user_id uuid,
  p_org_id uuid,
  p_app_id character varying,
  p_channel_id bigint,
  p_apikey text DEFAULT NULL::text
) RETURNS boolean
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

    IF v_channel_scope THEN
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

  IF v_channel_scope THEN
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
  text,
  uuid,
  uuid,
  character varying,
  bigint,
  text
) IS 'Direct RBAC permission check. Non-empty p_apikey selects the API-key '
   'principal unless it is only the request capgkey while JWT auth.uid() matches '
   'p_user_id (prefer JWT). Applies channel overrides and password/2FA for users. '
   'RLS should use rbac_check_permission_request.';

CREATE OR REPLACE FUNCTION public.rbac_check_permission_direct_no_password_policy(
  p_permission_key text,
  p_user_id uuid,
  p_org_id uuid,
  p_app_id character varying,
  p_channel_id bigint,
  p_apikey text DEFAULT NULL::text
) RETURNS boolean
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
  text,
  uuid,
  uuid,
  character varying,
  bigint,
  text
) IS 'Same as rbac_check_permission_direct but skips the password-policy gate. '
   'Non-empty p_apikey selects the API-key principal unless it is only the '
   'request capgkey while JWT auth.uid() matches p_user_id.';

CREATE OR REPLACE FUNCTION public.rbac_check_permission_request(
  p_permission_key text,
  p_org_id uuid DEFAULT NULL::uuid,
  p_app_id character varying DEFAULT NULL::character varying,
  p_channel_id bigint DEFAULT NULL::bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  RETURN public.rbac_check_permission_direct(
    p_permission_key,
    v_uid,
    p_org_id,
    p_app_id,
    p_channel_id,
    CASE
      WHEN v_uid IS NOT NULL THEN NULL::text
      ELSE NULLIF(btrim(public.get_apikey_header()), '')
    END
  );
END;
$$;

COMMENT ON FUNCTION public.rbac_check_permission_request(
  text,
  uuid,
  character varying,
  bigint
) IS 'Request-aware RBAC permission wrapper for RLS and SQL callers. '
   'Authenticated JWT requests evaluate the user principal; '
   'anonymous capgkey requests evaluate the API-key principal.';
