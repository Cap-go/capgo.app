-- Serialize pending-invite role updates with invitation acceptance via lock_rbac_orgs.
-- Permission is checked before acquiring the org lock so anonymous callers cannot
-- hold the advisory lock while authorization fails.

CREATE OR REPLACE FUNCTION rbac_internal.assert_assignable_org_invite_role_exists(
  p_new_role_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  role_id uuid;
BEGIN
  SELECT public.roles.id INTO role_id
  FROM public.roles
  WHERE public.roles.name = p_new_role_name
    AND public.roles.scope_type = public.rbac_scope_org()
    AND public.roles.is_assignable = true
  LIMIT 1;

  IF role_id IS NULL THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION rbac_internal.assert_invite_role_update_permission(
  p_org_id uuid,
  p_new_role_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  has_permission boolean;
BEGIN
  IF p_new_role_name = public.rbac_role_org_super_admin() THEN
    has_permission := public.rbac_check_permission_request(
      public.rbac_perm_org_update_user_roles(),
      p_org_id,
      NULL::character varying,
      NULL::bigint
    );
  ELSE
    has_permission := public.rbac_check_permission_request(
      public.rbac_perm_org_invite_user(),
      p_org_id,
      NULL::character varying,
      NULL::bigint
    );
  END IF;

  IF NOT has_permission THEN
    RAISE EXCEPTION 'NO_PERMISSION_TO_UPDATE_ROLES';
  END IF;
END;
$$;

ALTER FUNCTION rbac_internal.assert_assignable_org_invite_role_exists(text)
  OWNER TO postgres;
ALTER FUNCTION rbac_internal.assert_invite_role_update_permission(uuid, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION rbac_internal.assert_assignable_org_invite_role_exists(text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION rbac_internal.assert_invite_role_update_permission(uuid, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rbac_internal.assert_assignable_org_invite_role_exists(text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION rbac_internal.assert_invite_role_update_permission(uuid, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION rbac_internal.assert_assignable_org_invite_role_exists(text) IS
  'RLS/RPC helper: pending invite role must resolve to an assignable org-scope role.';
COMMENT ON FUNCTION rbac_internal.assert_invite_role_update_permission(uuid, text) IS
  'RLS/RPC helper: caller may update a pending invite role for the given org.';

CREATE OR REPLACE FUNCTION public.accept_invitation_to_org(org_id uuid)
RETURNS character varying
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
DECLARE
  invite public.org_users%ROWTYPE;
  invite_user_id uuid;
  invite_org_id uuid;
  role_name text;
  role_id uuid;
BEGIN
  -- Serialize with update_org/tmp_invite_role_rbac: read pending role only after
  -- the shared org lock so acceptance cannot observe a stale invite role.
  PERFORM public.lock_rbac_orgs(accept_invitation_to_org.org_id);

  SELECT public.org_users.*
  INTO invite
  FROM public.org_users
  WHERE public.org_users.org_id = accept_invitation_to_org.org_id
    AND public.org_users.user_id = auth.uid()
    AND public.org_users.is_invite IS TRUE
  ORDER BY public.org_users.created_at DESC NULLS LAST,
    public.org_users.id DESC
  LIMIT 1;

  IF invite.id IS NOT NULL THEN
    IF invite.rbac_role_name IS NULL THEN
      RETURN 'ROLE_NOT_FOUND';
    END IF;
    invite_user_id := invite.user_id;
    invite_org_id := invite.org_id;
    role_name := invite.rbac_role_name;
  ELSE
    SELECT rb.principal_id, rb.org_id, r.name
    INTO invite_user_id, invite_org_id, role_name
    FROM public.role_bindings rb
    JOIN public.roles r
      ON r.id = rb.role_id
      AND r.scope_type = rb.scope_type
    WHERE rb.principal_type = public.rbac_principal_user()
      AND rb.principal_id = auth.uid()
      AND rb.org_id = accept_invitation_to_org.org_id
      AND rb.scope_type = public.rbac_scope_org()
      AND rb.reason IN ('Pending invitation', 'Invited via invite_user_to_org_rbac')
    ORDER BY rb.granted_at DESC NULLS LAST
    LIMIT 1;

    IF invite_user_id IS NULL THEN
      RETURN 'NO_INVITE';
    END IF;
  END IF;

  IF role_name IS NULL THEN
    RETURN 'ROLE_NOT_FOUND';
  END IF;

  SELECT public.roles.id INTO role_id
  FROM public.roles
  WHERE public.roles.name = role_name
    AND public.roles.scope_type = public.rbac_scope_org()
    AND public.roles.is_assignable = true
  LIMIT 1;

  IF role_id IS NULL THEN
    RETURN 'ROLE_NOT_FOUND';
  END IF;

  -- Keep is_invite true until after the accepted binding is inserted so the
  -- privilege guards can verify this is a real invite acceptance.
  IF invite.id IS NULL THEN
    INSERT INTO public.org_users (user_id, org_id, rbac_role_name, is_invite)
    VALUES (invite_user_id, invite_org_id, role_name, true);
  END IF;

  DELETE FROM public.role_bindings
  WHERE public.role_bindings.principal_type = public.rbac_principal_user()
    AND public.role_bindings.principal_id = invite_user_id
    AND public.role_bindings.scope_type = public.rbac_scope_org()
    AND public.role_bindings.org_id = invite_org_id;

  INSERT INTO public.role_bindings (
    principal_type,
    principal_id,
    role_id,
    scope_type,
    org_id,
    app_id,
    channel_id,
    granted_by,
    granted_at,
    reason,
    is_direct
  ) VALUES (
    public.rbac_principal_user(),
    invite_user_id,
    role_id,
    public.rbac_scope_org(),
    invite_org_id,
    NULL,
    NULL,
    auth.uid(),
    pg_catalog.now(),
    'Accepted invitation',
    true
  ) ON CONFLICT DO NOTHING;

  UPDATE public.org_users
  SET is_invite = false,
      rbac_role_name = role_name,
      updated_at = pg_catalog.now()
  WHERE public.org_users.user_id = invite_user_id
    AND public.org_users.org_id = invite_org_id
    AND public.org_users.is_invite IS TRUE;

  RETURN 'OK';
END;
$$;

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
BEGIN
  PERFORM rbac_internal.assert_assignable_org_invite_role_exists(p_new_role_name);
  PERFORM rbac_internal.assert_invite_role_update_permission(p_org_id, p_new_role_name);
  PERFORM public.lock_rbac_orgs(p_org_id);
  PERFORM rbac_internal.assert_invite_role_update_permission(p_org_id, p_new_role_name);

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
BEGIN
  PERFORM rbac_internal.assert_assignable_org_invite_role_exists(p_new_role_name);
  PERFORM rbac_internal.assert_invite_role_update_permission(p_org_id, p_new_role_name);
  PERFORM public.lock_rbac_orgs(p_org_id);
  PERFORM rbac_internal.assert_invite_role_update_permission(p_org_id, p_new_role_name);

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

COMMENT ON FUNCTION public.accept_invitation_to_org(uuid) IS
  'Accepts a pending org invite and creates the active RBAC binding. Kept for old '
  'clients. Acquires lock_rbac_orgs before reading the pending invite role.';
