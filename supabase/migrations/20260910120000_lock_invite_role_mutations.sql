-- Serialize pending-invite role updates with invitation acceptance via lock_rbac_orgs.

CREATE OR REPLACE FUNCTION public.update_org_invite_role_rbac(
  p_org_id uuid,
  p_user_id uuid,
  p_new_role_name text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  role_id uuid;
BEGIN
  PERFORM public.lock_rbac_orgs(p_org_id);

  SELECT public.roles.id INTO role_id
  FROM public.roles
  WHERE public.roles.name = p_new_role_name
    AND public.roles.scope_type = public.rbac_scope_org()
    AND public.roles.is_assignable = true
  LIMIT 1;

  IF role_id IS NULL THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  IF p_new_role_name = public.rbac_role_org_super_admin() THEN
    IF NOT public.rbac_check_permission_request(
      public.rbac_perm_org_update_user_roles(),
      p_org_id,
      NULL::character varying,
      NULL::bigint
    ) THEN
      RAISE EXCEPTION 'NO_PERMISSION_TO_UPDATE_ROLES';
    END IF;
  ELSE
    IF NOT public.rbac_check_permission_request(
      public.rbac_perm_org_invite_user(),
      p_org_id,
      NULL::character varying,
      NULL::bigint
    ) THEN
      RAISE EXCEPTION 'NO_PERMISSION_TO_UPDATE_ROLES';
    END IF;
  END IF;

  UPDATE public.org_users
  SET rbac_role_name = p_new_role_name,
      updated_at = pg_catalog.now()
  WHERE public.org_users.org_id = p_org_id
    AND public.org_users.user_id = p_user_id
    AND public.org_users.is_invite IS TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_INVITATION';
  END IF;

  RETURN 'OK';
END;
$$;

CREATE OR REPLACE FUNCTION public.update_tmp_invite_role_rbac(
  p_org_id uuid,
  p_email text,
  p_new_role_name text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  role_id uuid;
BEGIN
  PERFORM public.lock_rbac_orgs(p_org_id);

  SELECT public.roles.id INTO role_id
  FROM public.roles
  WHERE public.roles.name = p_new_role_name
    AND public.roles.scope_type = public.rbac_scope_org()
    AND public.roles.is_assignable = true
  LIMIT 1;

  IF role_id IS NULL THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  IF p_new_role_name = public.rbac_role_org_super_admin() THEN
    IF NOT public.rbac_check_permission_request(
      public.rbac_perm_org_update_user_roles(),
      p_org_id,
      NULL::character varying,
      NULL::bigint
    ) THEN
      RAISE EXCEPTION 'NO_PERMISSION_TO_UPDATE_ROLES';
    END IF;
  ELSE
    IF NOT public.rbac_check_permission_request(
      public.rbac_perm_org_invite_user(),
      p_org_id,
      NULL::character varying,
      NULL::bigint
    ) THEN
      RAISE EXCEPTION 'NO_PERMISSION_TO_UPDATE_ROLES';
    END IF;
  END IF;

  UPDATE public.tmp_users
  SET rbac_role_name = p_new_role_name,
      updated_at = pg_catalog.now()
  WHERE public.tmp_users.org_id = p_org_id
    AND public.tmp_users.email = p_email
    AND public.tmp_users.cancelled_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_INVITATION';
  END IF;

  RETURN 'OK';
END;
$$;
