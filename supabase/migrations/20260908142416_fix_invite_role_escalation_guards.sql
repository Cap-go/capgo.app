-- Block invite-role escalation via tmp_users RPCs and revalidate inviter rank at acceptance.

CREATE OR REPLACE FUNCTION public.assert_principal_can_grant_org_role(
  p_org_id uuid,
  p_principal_id uuid,
  p_role_name text,
  p_mutation text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_target_priority integer;
  v_caller_priority integer;
BEGIN
  IF p_org_id IS NULL OR p_principal_id IS NULL OR p_role_name IS NULL THEN
    PERFORM public.pg_log(
      'deny: RBAC_INVITE_GRANT_UNKNOWN_TARGET',
      pg_catalog.jsonb_build_object(
        'org_id', p_org_id,
        'principal_id', p_principal_id,
        'mutation', p_mutation
      )
    );
    RAISE EXCEPTION 'Admins cannot elevate privileges!';
  END IF;

  SELECT roles.priority_rank
  INTO v_target_priority
  FROM public.roles
  WHERE roles.name = p_role_name
    AND roles.scope_type = public.rbac_scope_org()
    AND roles.is_assignable IS TRUE
  LIMIT 1;

  IF v_target_priority IS NULL THEN
    PERFORM public.pg_log(
      'deny: RBAC_INVITE_GRANT_UNKNOWN_ROLE',
      pg_catalog.jsonb_build_object(
        'org_id', p_org_id,
        'principal_id', p_principal_id,
        'role_name', p_role_name,
        'mutation', p_mutation
      )
    );
    RAISE EXCEPTION 'Admins cannot elevate privileges!';
  END IF;

  v_caller_priority := public.principal_max_role_priority(
    p_org_id,
    public.rbac_principal_user(),
    p_principal_id
  );

  IF v_caller_priority IS NULL OR v_caller_priority < v_target_priority THEN
    PERFORM public.pg_log(
      'deny: RBAC_INVITE_GRANT_PRIORITY_ESCALATION',
      pg_catalog.jsonb_build_object(
        'org_id', p_org_id,
        'principal_id', p_principal_id,
        'mutation', p_mutation,
        'caller_max_priority', v_caller_priority,
        'target_role_priority', v_target_priority
      )
    );
    RAISE EXCEPTION 'Admins cannot elevate privileges!';
  END IF;
END;
$$;

ALTER FUNCTION public.assert_principal_can_grant_org_role(uuid, uuid, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.assert_principal_can_grant_org_role(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_principal_can_grant_org_role(uuid, uuid, text, text) TO service_role;

ALTER TABLE public.tmp_users
  ADD COLUMN IF NOT EXISTS invited_by_user_id uuid;

CREATE OR REPLACE FUNCTION public.update_tmp_invite_role_rbac(
  p_org_id uuid,
  p_email text,
  p_new_role_name text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  role_id uuid;
  role_priority integer;
BEGIN
  PERFORM public.lock_rbac_orgs(p_org_id);

  SELECT r.id, r.priority_rank
  INTO role_id, role_priority
  FROM public.roles r
  WHERE r.name = p_new_role_name
    AND r.scope_type = public.rbac_scope_org()
    AND r.is_assignable = true
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

  PERFORM public.assert_request_principal_rank(
    p_org_id,
    role_priority,
    'tmp_invite_role_update'
  );

  UPDATE public.tmp_users
  SET rbac_role_name = p_new_role_name,
      updated_at = now()
  WHERE org_id = p_org_id
    AND email = p_email
    AND cancelled_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_INVITATION';
  END IF;

  RETURN 'OK';
END;
$$;

CREATE OR REPLACE FUNCTION public.update_org_invite_role_rbac(
  p_org_id uuid,
  p_user_id uuid,
  p_new_role_name text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  role_id uuid;
  role_priority integer;
BEGIN
  PERFORM public.lock_rbac_orgs(p_org_id);

  SELECT r.id, r.priority_rank
  INTO role_id, role_priority
  FROM public.roles r
  WHERE r.name = p_new_role_name
    AND r.scope_type = public.rbac_scope_org()
    AND r.is_assignable = true
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

  PERFORM public.assert_request_principal_rank(
    p_org_id,
    role_priority,
    'org_invite_role_update'
  );

  UPDATE public.org_users
  SET rbac_role_name = p_new_role_name,
      updated_at = now()
  WHERE org_id = p_org_id
    AND user_id = p_user_id
    AND is_invite IS TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_INVITATION';
  END IF;

  RETURN 'OK';
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_tmp_user_invitation(
  p_invite_magic_string text,
  p_user_id uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
DECLARE
  v_org_id uuid;
  v_invite public.tmp_users%ROWTYPE;
  v_role_id uuid;
  v_rbac_role_name text;
  v_finalize_rows integer;
BEGIN
  SELECT tmp_users.org_id
  INTO v_org_id
  FROM public.tmp_users
  WHERE tmp_users.invite_magic_string = p_invite_magic_string
    AND tmp_users.cancelled_at IS NULL
  LIMIT 1;

  IF v_org_id IS NULL THEN
    RETURN 'NO_INVITE';
  END IF;

  PERFORM public.lock_rbac_orgs(v_org_id);

  SELECT tmp_users.*
  INTO v_invite
  FROM public.tmp_users
  WHERE tmp_users.invite_magic_string = p_invite_magic_string
    AND tmp_users.cancelled_at IS NULL
  LIMIT 1
  FOR UPDATE;

  IF v_invite.id IS NULL THEN
    RETURN 'NO_INVITE';
  END IF;

  v_rbac_role_name := pg_catalog.btrim(v_invite.rbac_role_name);
  IF v_rbac_role_name IS NULL OR v_rbac_role_name = '' THEN
    RETURN 'ROLE_NOT_FOUND';
  END IF;

  -- Invites created before invited_by_user_id was recorded lack inviter attribution.
  IF v_invite.invited_by_user_id IS NULL THEN
    RETURN 'INVITER_NOT_FOUND';
  END IF;

  PERFORM public.assert_principal_can_grant_org_role(
    v_invite.org_id,
    v_invite.invited_by_user_id,
    v_rbac_role_name,
    'accept_tmp_user_invitation'
  );

  SELECT roles.id
  INTO v_role_id
  FROM public.roles
  WHERE roles.name = v_rbac_role_name
    AND roles.scope_type = public.rbac_scope_org()
    AND roles.is_assignable = true
  LIMIT 1;

  IF v_role_id IS NULL THEN
    RETURN 'ROLE_NOT_FOUND';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.org_users
    WHERE org_users.user_id = p_user_id
      AND org_users.org_id = v_invite.org_id
      AND org_users.app_id IS NULL
      AND org_users.channel_id IS NULL
      AND org_users.is_invite IS FALSE
  ) THEN
    RETURN 'ALREADY_MEMBER';
  END IF;

  -- Keep is_invite true until after the accepted binding is inserted.
  IF NOT EXISTS (
    SELECT 1
    FROM public.org_users
    WHERE org_users.user_id = p_user_id
      AND org_users.org_id = v_invite.org_id
      AND org_users.app_id IS NULL
      AND org_users.channel_id IS NULL
  ) THEN
    INSERT INTO public.org_users (user_id, org_id, rbac_role_name, is_invite)
    VALUES (p_user_id, v_invite.org_id, v_rbac_role_name, true);
  ELSE
    UPDATE public.org_users
    SET rbac_role_name = v_rbac_role_name,
        updated_at = now()
    WHERE org_users.user_id = p_user_id
      AND org_users.org_id = v_invite.org_id
      AND org_users.app_id IS NULL
      AND org_users.channel_id IS NULL
      AND org_users.is_invite IS TRUE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.org_users
    WHERE org_users.user_id = p_user_id
      AND org_users.org_id = v_invite.org_id
      AND org_users.app_id IS NULL
      AND org_users.channel_id IS NULL
      AND org_users.is_invite IS TRUE
  ) THEN
    RETURN 'MEMBERSHIP_NOT_FINALIZED';
  END IF;

  DELETE FROM public.role_bindings
  WHERE role_bindings.principal_type = public.rbac_principal_user()
    AND role_bindings.principal_id = p_user_id
    AND role_bindings.scope_type = public.rbac_scope_org()
    AND role_bindings.org_id = v_invite.org_id;

  INSERT INTO public.role_bindings (
    principal_type,
    principal_id,
    role_id,
    scope_type,
    org_id,
    granted_by,
    granted_at,
    reason,
    is_direct
  ) VALUES (
    public.rbac_principal_user(),
    p_user_id,
    v_role_id,
    public.rbac_scope_org(),
    v_invite.org_id,
    v_invite.invited_by_user_id,
    now(),
    'Accepted invitation',
    true
  );

  UPDATE public.org_users
  SET is_invite = false,
      rbac_role_name = v_rbac_role_name,
      updated_at = now()
  WHERE org_users.user_id = p_user_id
    AND org_users.org_id = v_invite.org_id
    AND org_users.app_id IS NULL
    AND org_users.channel_id IS NULL
    AND org_users.is_invite IS TRUE;

  GET DIAGNOSTICS v_finalize_rows = ROW_COUNT;
  IF v_finalize_rows = 0 THEN
    RAISE EXCEPTION 'MEMBERSHIP_NOT_FINALIZED';
  END IF;

  DELETE FROM public.tmp_users
  WHERE tmp_users.id = v_invite.id;

  RETURN 'OK';
END;
$$;

ALTER FUNCTION public.accept_tmp_user_invitation(text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.accept_tmp_user_invitation(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_tmp_user_invitation(text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.accept_invitation_to_org(org_id uuid) RETURNS character varying
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
  v_inviter_id uuid;
  v_finalize_rows integer;
BEGIN
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

    SELECT rb.granted_by
    INTO v_inviter_id
    FROM public.role_bindings rb
    WHERE rb.principal_type = public.rbac_principal_user()
      AND rb.principal_id = invite_user_id
      AND rb.org_id = invite_org_id
      AND rb.scope_type = public.rbac_scope_org()
      AND rb.reason IN ('Pending invitation', 'Invited via invite_user_to_org_rbac')
    ORDER BY rb.granted_at DESC NULLS LAST
    LIMIT 1;
  ELSE
    SELECT rb.principal_id, rb.org_id, r.name, rb.granted_by
    INTO invite_user_id, invite_org_id, role_name, v_inviter_id
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

  SELECT public.roles.id
  INTO role_id
  FROM public.roles
  WHERE public.roles.name = role_name
    AND public.roles.scope_type = public.rbac_scope_org()
    AND public.roles.is_assignable = true
  LIMIT 1;

  IF role_id IS NULL THEN
    RETURN 'ROLE_NOT_FOUND';
  END IF;

  IF v_inviter_id IS NULL THEN
    RETURN 'INVITER_NOT_FOUND';
  END IF;

  PERFORM public.assert_principal_can_grant_org_role(
    invite_org_id,
    v_inviter_id,
    role_name,
    'accept_invitation_to_org'
  );

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
    now(),
    'Accepted invitation',
    true
  ) ON CONFLICT DO NOTHING;

  UPDATE public.org_users
  SET is_invite = false,
      rbac_role_name = role_name,
      updated_at = CURRENT_TIMESTAMP
  WHERE public.org_users.user_id = invite_user_id
    AND public.org_users.org_id = invite_org_id
    AND public.org_users.is_invite IS TRUE;

  GET DIAGNOSTICS v_finalize_rows = ROW_COUNT;
  IF v_finalize_rows = 0 THEN
    RAISE EXCEPTION 'MEMBERSHIP_NOT_FINALIZED';
  END IF;

  RETURN 'OK';
END;
$$;

COMMENT ON FUNCTION public.assert_principal_can_grant_org_role(uuid, uuid, text, text)
  IS 'Ensures a principal can grant an org-scoped role at or below their max rank. Used for invite acceptance validation.';

COMMENT ON FUNCTION public.accept_tmp_user_invitation(text, uuid)
  IS 'Atomically validates inviter rank and finalizes a tmp_users invitation (org membership + role binding + invite delete).';
