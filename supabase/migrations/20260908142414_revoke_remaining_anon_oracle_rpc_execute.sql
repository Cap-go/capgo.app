-- Complete the anon oracle RPC hardening started in
-- 20260824144021_revoke_anon_oracle_rpc_execute.sql.
--
-- 1) Revoke anonymous EXECUTE on SECURITY DEFINER helpers that enumerate or
--    infer org/app/member state and are only needed from signed-in console JWT
--    traffic (authenticated role). Published CLI keeps anon EXECUTE on
--    get_user_id(text) and the capgkey-scoped helpers it still calls.
-- 2) Remove distinguishable "Organization does not exist" vs "NO_RIGHTS"
--    outcomes from org-member helpers that must remain anon-callable for CLI.
--    Internal/service_role callers still get ORG_NOT_FOUND for a missing org.

-- ---------------------------------------------------------------------------
-- Fix org-member helpers: same denial for missing org and missing permission.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.check_org_members_2fa_enabled(org_id uuid)
RETURNS TABLE(user_id uuid, "2fa_enabled" boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Internal callers keep a distinguishable missing-org signal; non-internal
  -- callers still collapse missing-org into NO_RIGHTS (anon oracle closed).
  IF public.is_internal_request_role(public.current_request_role()) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.orgs
      WHERE public.orgs.id = check_org_members_2fa_enabled.org_id
    ) THEN
      RAISE EXCEPTION 'ORG_NOT_FOUND';
    END IF;
  ELSIF (
      NOT EXISTS (
        SELECT 1
        FROM public.orgs
        WHERE public.orgs.id = check_org_members_2fa_enabled.org_id
      )
      OR NOT public.rbac_check_permission_request(
        public.rbac_perm_org_update_settings(),
        check_org_members_2fa_enabled.org_id,
        NULL::character varying,
        NULL::bigint
      )
    )
  THEN
    RAISE EXCEPTION 'NO_RIGHTS';
  END IF;

  RETURN QUERY
  SELECT DISTINCT
    rb.principal_id AS user_id,
    COALESCE(public.has_2fa_enabled(rb.principal_id), false) AS "2fa_enabled"
  FROM public.role_bindings rb
  JOIN public.roles r ON r.id = rb.role_id
    AND r.scope_type = rb.scope_type
  WHERE rb.principal_type = public.rbac_principal_user()
    AND rb.scope_type = public.rbac_scope_org()
    AND rb.org_id = check_org_members_2fa_enabled.org_id
    AND (rb.expires_at IS NULL OR rb.expires_at > now())
    AND r.name LIKE 'org_%';
END;
$$;

ALTER FUNCTION public.check_org_members_2fa_enabled(uuid) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.check_org_members_password_policy(org_id uuid)
RETURNS TABLE(
  user_id uuid,
  email text,
  first_name text,
  last_name text,
  password_policy_compliant boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Internal callers keep a distinguishable missing-org signal; non-internal
  -- callers still collapse missing-org into NO_RIGHTS (anon oracle closed).
  IF public.is_internal_request_role(public.current_request_role()) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.orgs
      WHERE public.orgs.id = check_org_members_password_policy.org_id
    ) THEN
      RAISE EXCEPTION 'ORG_NOT_FOUND';
    END IF;
  ELSIF (
      NOT EXISTS (
        SELECT 1
        FROM public.orgs
        WHERE public.orgs.id = check_org_members_password_policy.org_id
      )
      OR NOT public.rbac_check_permission_request(
        public.rbac_perm_org_update_settings(),
        check_org_members_password_policy.org_id,
        NULL::character varying,
        NULL::bigint
      )
    )
  THEN
    RAISE EXCEPTION 'NO_RIGHTS';
  END IF;

  RETURN QUERY
  SELECT DISTINCT
    rb.principal_id AS user_id,
    au.email::text,
    u.first_name::text,
    u.last_name::text,
    public.user_meets_password_policy(
      rb.principal_id,
      check_org_members_password_policy.org_id
    ) AS password_policy_compliant
  FROM public.role_bindings rb
  JOIN public.roles r ON r.id = rb.role_id
    AND r.scope_type = rb.scope_type
  JOIN auth.users au ON au.id = rb.principal_id
  LEFT JOIN public.users u ON u.id = rb.principal_id
  WHERE rb.principal_type = public.rbac_principal_user()
    AND rb.scope_type = public.rbac_scope_org()
    AND rb.org_id = check_org_members_password_policy.org_id
    AND (rb.expires_at IS NULL OR rb.expires_at > now())
    AND r.name LIKE 'org_%';
END;
$$;

ALTER FUNCTION public.check_org_members_password_policy(uuid) OWNER TO postgres;

-- ---------------------------------------------------------------------------
-- Revoke anonymous EXECUTE on org/member oracle RPCs (console uses JWT).
-- exist_app / exist_app_v2 stay anon-callable: they return false without a
-- valid capgkey and do not distinguish missing apps from denied access.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.get_org_members_rbac(uuid) FROM anon;

REVOKE ALL ON FUNCTION public.is_member_of_org(uuid, uuid) FROM anon;

REVOKE ALL ON FUNCTION public.update_org_invite_role_rbac(
  uuid, uuid, text
) FROM anon;

REVOKE ALL ON FUNCTION public.update_tmp_invite_role_rbac(
  uuid, text, text
) FROM anon;

GRANT EXECUTE ON FUNCTION public.get_org_members_rbac(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_org_members_rbac(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.is_member_of_org(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_member_of_org(uuid, uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.update_org_invite_role_rbac(
  uuid, uuid, text
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_org_invite_role_rbac(
  uuid, uuid, text
) TO service_role;

GRANT EXECUTE ON FUNCTION public.update_tmp_invite_role_rbac(
  uuid, text, text
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_tmp_invite_role_rbac(
  uuid, text, text
) TO service_role;
