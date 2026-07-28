-- Allow invitees to accept their own pending organization invitations.
-- Privilege-escalation guards correctly block callers from assigning roles above
-- their rank, but accept_invitation_to_org runs as the invitee. Without an
-- invite-acceptance exception, accepting org_admin (or any high-rank invite)
-- raises P0001 "Admins cannot elevate privileges!".

CREATE OR REPLACE FUNCTION "public"."accept_invitation_to_org"("org_id" "uuid") RETURNS character varying
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    SET "row_security" TO 'off'
    AS $$
DECLARE
  invite public.org_users%ROWTYPE;
  invite_user_id uuid;
  invite_org_id uuid;
  role_name text;
  role_id uuid;
BEGIN
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

  RETURN 'OK';
END;
$$;

CREATE OR REPLACE FUNCTION "public"."check_org_user_privileges"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_actor_id uuid;
  v_api_key_text text;
  v_api_key public.apikeys%ROWTYPE;
  v_principal_type text;
  v_principal_id uuid;
  v_target_role_priority integer;
  v_caller_max_priority integer := 0;
BEGIN
  IF public.is_internal_request_role(public.current_request_role()) THEN
    RETURN NEW;
  END IF;

  IF pg_trigger_depth() > 1
    AND current_setting('capgo.org_creation_bootstrap_org_id', true) = NEW.org_id::text
    AND EXISTS (
      SELECT 1
      FROM public.orgs
      WHERE orgs.id = NEW.org_id
        AND orgs.created_by = NEW.user_id
    )
  THEN
    RETURN NEW;
  END IF;

  v_actor_id := public.request_actor_user_id();

  -- Invitees may create/activate their own pending membership for the invited role.
  IF v_actor_id IS NOT NULL
    AND NEW.user_id = v_actor_id
    AND (
      (
        TG_OP = 'UPDATE'
        AND COALESCE(OLD.is_invite, false) IS TRUE
        AND COALESCE(NEW.is_invite, false) IS FALSE
        AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
        AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
        AND (
          NEW.rbac_role_name IS NOT DISTINCT FROM OLD.rbac_role_name
          OR EXISTS (
            SELECT 1
            FROM public.role_bindings rb
            JOIN public.roles r
              ON r.id = rb.role_id
              AND r.scope_type = rb.scope_type
            WHERE rb.principal_type = public.rbac_principal_user()
              AND rb.principal_id = NEW.user_id
              AND rb.org_id = NEW.org_id
              AND rb.scope_type = public.rbac_scope_org()
              AND r.name = NEW.rbac_role_name
              AND rb.reason IN ('Pending invitation', 'Invited via invite_user_to_org_rbac', 'Accepted invitation')
          )
        )
      )
      OR (
        TG_OP = 'INSERT'
        AND EXISTS (
          SELECT 1
          FROM public.role_bindings rb
          JOIN public.roles r
            ON r.id = rb.role_id
            AND r.scope_type = rb.scope_type
          WHERE rb.principal_type = public.rbac_principal_user()
            AND rb.principal_id = NEW.user_id
            AND rb.org_id = NEW.org_id
            AND rb.scope_type = public.rbac_scope_org()
            AND r.name = NEW.rbac_role_name
            AND rb.reason IN ('Pending invitation', 'Invited via invite_user_to_org_rbac')
        )
      )
    )
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
    AND (
      NEW.org_id IS DISTINCT FROM OLD.org_id
      OR NEW.user_id IS DISTINCT FROM OLD.user_id
    )
  THEN
    PERFORM public.pg_log(
      'deny: ORG_USER_MEMBERSHIP_MOVE',
      pg_catalog.jsonb_build_object('org_id', NEW.org_id, 'uid', v_actor_id)
    );
    RAISE EXCEPTION 'Admins cannot move org memberships!';
  END IF;

  SELECT roles.priority_rank
  INTO v_target_role_priority
  FROM public.roles
  WHERE roles.name = NEW.rbac_role_name
    AND roles.scope_type = public.rbac_scope_org()
    AND roles.is_assignable IS TRUE
  LIMIT 1;

  IF v_target_role_priority IS NULL THEN
    PERFORM public.pg_log(
      'deny: ORG_USER_ROLE_UNKNOWN',
      pg_catalog.jsonb_build_object('org_id', NEW.org_id, 'uid', v_actor_id, 'role', NEW.rbac_role_name)
    );
    RAISE EXCEPTION 'Admins cannot assign this role!';
  END IF;

  IF v_actor_id IS NULL
    OR NOT public.rbac_check_permission_request(
      public.rbac_perm_org_update_user_roles(),
      NEW.org_id,
      NULL::character varying,
      NULL::bigint
    )
  THEN
    PERFORM public.pg_log(
      'deny: ORG_USER_ROLE_UPDATE',
      pg_catalog.jsonb_build_object('org_id', NEW.org_id, 'uid', v_actor_id)
    );
    RAISE EXCEPTION 'Admins cannot elevate privileges!';
  END IF;

  v_api_key_text := public.get_apikey_header();
  IF v_api_key_text IS NOT NULL THEN
    SELECT *
    INTO v_api_key
    FROM public.find_apikey_by_value(v_api_key_text)
    LIMIT 1;

    IF v_api_key.id IS NULL OR public.is_apikey_expired(v_api_key.expires_at) THEN
      PERFORM public.pg_log(
        'deny: ORG_USER_ROLE_INVALID_API_KEY',
        pg_catalog.jsonb_build_object('org_id', NEW.org_id, 'uid', v_actor_id)
      );
      RAISE EXCEPTION 'Admins cannot elevate privileges!';
    END IF;

    v_principal_type := public.rbac_principal_apikey();
    v_principal_id := v_api_key.rbac_id;
  ELSE
    v_principal_type := public.rbac_principal_user();
    v_principal_id := v_actor_id;
  END IF;

  IF v_principal_id IS NULL THEN
    PERFORM public.pg_log(
      'deny: ORG_USER_ROLE_MISSING_PRINCIPAL',
      pg_catalog.jsonb_build_object('org_id', NEW.org_id, 'uid', v_actor_id)
    );
    RAISE EXCEPTION 'Admins cannot elevate privileges!';
  END IF;

  IF v_principal_type = public.rbac_principal_apikey() THEN
    SELECT COALESCE(pg_catalog.MAX(roles.priority_rank), 0)
    INTO v_caller_max_priority
    FROM public.role_bindings
    JOIN public.roles
      ON roles.id = role_bindings.role_id
      AND roles.scope_type = role_bindings.scope_type
    WHERE role_bindings.principal_type = public.rbac_principal_apikey()
      AND role_bindings.principal_id = v_principal_id
      AND role_bindings.org_id = NEW.org_id
      AND (
        role_bindings.expires_at IS NULL
        OR role_bindings.expires_at > pg_catalog.now()
      );
  ELSE
    SELECT COALESCE(pg_catalog.MAX(roles.priority_rank), 0)
    INTO v_caller_max_priority
    FROM (
      SELECT role_bindings.role_id, role_bindings.scope_type
      FROM public.role_bindings
      WHERE role_bindings.principal_type = public.rbac_principal_user()
        AND role_bindings.principal_id = v_principal_id
        AND role_bindings.org_id = NEW.org_id
        AND (
          role_bindings.expires_at IS NULL
          OR role_bindings.expires_at > pg_catalog.now()
        )

      UNION ALL

      SELECT role_bindings.role_id, role_bindings.scope_type
      FROM public.group_members
      JOIN public.groups
        ON groups.id = group_members.group_id
        AND groups.org_id = NEW.org_id
      JOIN public.role_bindings
        ON role_bindings.principal_type = public.rbac_principal_group()
        AND role_bindings.principal_id = group_members.group_id
        AND role_bindings.org_id = groups.org_id
      WHERE group_members.user_id = v_principal_id
        AND (
          role_bindings.expires_at IS NULL
          OR role_bindings.expires_at > pg_catalog.now()
        )
    ) active_caller_bindings
    JOIN public.roles
      ON roles.id = active_caller_bindings.role_id
      AND roles.scope_type = active_caller_bindings.scope_type;
  END IF;

  IF v_caller_max_priority < v_target_role_priority THEN
    PERFORM public.pg_log(
      'deny: ORG_USER_ROLE_PRIORITY_ESCALATION',
      pg_catalog.jsonb_build_object(
        'org_id',
        NEW.org_id,
        'uid',
        v_actor_id,
        'role',
        NEW.rbac_role_name,
        'caller_max_priority',
        v_caller_max_priority,
        'target_role_priority',
        v_target_role_priority
      )
    );
    RAISE EXCEPTION 'Admins cannot elevate privileges!';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."prevent_role_binding_priority_escalation"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_old_role_priority integer;
  v_new_role_priority integer;
  v_actor_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.lock_rbac_orgs(OLD.org_id);
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM public.lock_rbac_orgs(NEW.org_id);
  ELSE
    PERFORM public.lock_rbac_orgs(OLD.org_id, NEW.org_id);
  END IF;

  IF (TG_OP = 'DELETE' AND public.is_org_delete_cascade(OLD.org_id))
    OR (TG_OP = 'INSERT' AND public.is_org_delete_cascade(NEW.org_id))
    OR (TG_OP = 'UPDATE' AND (public.is_org_delete_cascade(OLD.org_id) OR public.is_org_delete_cascade(NEW.org_id)))
  THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF NOT (
      (
        OLD.principal_type = public.rbac_principal_user()
        AND public.is_nested_self_org_departure_cleanup(OLD.org_id, OLD.principal_id)
      )
      OR (
        OLD.principal_type = public.rbac_principal_apikey()
        AND EXISTS (
          SELECT 1
          FROM public.apikeys
          WHERE apikeys.rbac_id = OLD.principal_id
            AND public.is_nested_self_org_departure_cleanup(OLD.org_id, apikeys.user_id)
        )
      )
    ) THEN
      PERFORM public.assert_effective_super_admin_binding_removal(OLD.id, 'CANNOT_DELETE_LAST_SUPER_ADMIN_BINDING');
    END IF;
  ELSIF TG_OP = 'UPDATE'
    AND NOT (
      NEW.org_id IS NOT DISTINCT FROM OLD.org_id
      AND NEW.principal_type IS NOT DISTINCT FROM OLD.principal_type
      AND NEW.principal_id IS NOT DISTINCT FROM OLD.principal_id
      AND public.is_active_org_super_admin_binding(
        NEW.role_id,
        NEW.scope_type,
        NEW.principal_type,
        NEW.org_id,
        NEW.expires_at
      )
    )
  THEN
    PERFORM public.assert_effective_super_admin_binding_removal(OLD.id, 'CANNOT_DEMOTE_LAST_SUPER_ADMIN_BINDING');
  END IF;

  -- A future expiry removes this binding. Keep another non-expiring effective
  -- administrator so a chain of scheduled expirations cannot orphan the org.
  IF TG_OP = 'UPDATE'
    AND NEW.expires_at IS NOT NULL
    AND NEW.expires_at IS DISTINCT FROM OLD.expires_at
    AND public.is_active_org_super_admin_binding(
      OLD.role_id,
      OLD.scope_type,
      OLD.principal_type,
      OLD.org_id,
      OLD.expires_at
    )
    AND public.is_active_org_super_admin_binding(
      NEW.role_id,
      NEW.scope_type,
      NEW.principal_type,
      NEW.org_id,
      NEW.expires_at
    )
    AND NOT public.has_effective_non_expiring_org_super_admin_after_removal(
      NEW.org_id,
      OLD.id
    )
  THEN
    RAISE EXCEPTION 'CANNOT_DEMOTE_LAST_SUPER_ADMIN_BINDING'
      USING HINT = 'At least one effective active organization super admin must remain after this binding expires.';
  END IF;

  IF public.is_internal_request_role(public.current_request_role()) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  v_actor_id := auth.uid();

  -- Invitees may clear their own pending invite bindings and insert the accepted
  -- binding for the same invited role while the org_users invite is still pending.
  IF TG_OP = 'DELETE'
    AND v_actor_id IS NOT NULL
    AND OLD.principal_type = public.rbac_principal_user()
    AND OLD.principal_id = v_actor_id
    AND OLD.scope_type = public.rbac_scope_org()
    AND (
      OLD.reason IN ('Pending invitation', 'Invited via invite_user_to_org_rbac')
      OR EXISTS (
        SELECT 1
        FROM public.org_users
        WHERE org_users.user_id = v_actor_id
          AND org_users.org_id = OLD.org_id
          AND org_users.is_invite IS TRUE
      )
    )
  THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT'
    AND v_actor_id IS NOT NULL
    AND NEW.principal_type = public.rbac_principal_user()
    AND NEW.principal_id = v_actor_id
    AND NEW.scope_type = public.rbac_scope_org()
    AND NEW.reason = 'Accepted invitation'
    AND NEW.app_id IS NULL
    AND NEW.bundle_id IS NULL
    AND NEW.channel_id IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.org_users
      JOIN public.roles
        ON roles.name = org_users.rbac_role_name
        AND roles.scope_type = public.rbac_scope_org()
      WHERE org_users.user_id = v_actor_id
        AND org_users.org_id = NEW.org_id
        AND org_users.is_invite IS TRUE
        AND roles.id = NEW.role_id
    )
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE'
    AND (
      (
        OLD.principal_type = public.rbac_principal_user()
        AND public.is_nested_self_org_departure_cleanup(OLD.org_id, OLD.principal_id)
      )
      OR (
        OLD.principal_type = public.rbac_principal_apikey()
        AND EXISTS (
          SELECT 1
          FROM public.apikeys
          WHERE apikeys.rbac_id = OLD.principal_id
            AND public.is_nested_self_org_departure_cleanup(OLD.org_id, apikeys.user_id)
        )
      )
    )
  THEN
    RETURN OLD;
  END IF;

  IF TG_OP <> 'DELETE'
    AND pg_trigger_depth() > 1
    AND current_setting('capgo.org_creation_bootstrap_org_id', true) = NEW.org_id::text
    AND NEW.principal_type = public.rbac_principal_user()
    AND NEW.scope_type = public.rbac_scope_org()
    AND NEW.principal_id = NEW.granted_by
    AND NEW.app_id IS NULL
    AND NEW.bundle_id IS NULL
    AND NEW.channel_id IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.orgs
      WHERE orgs.id = NEW.org_id
        AND orgs.created_by = NEW.principal_id
    )
    AND EXISTS (
      SELECT 1
      FROM public.roles
      WHERE roles.id = NEW.role_id
        AND roles.scope_type = public.rbac_scope_org()
        AND roles.name = public.rbac_role_org_super_admin()
    )
  THEN
    RETURN NEW;
  END IF;

  -- The channel insert trigger is the sole creator of this non-assignable role.
  -- validate_channel_preview_role_binding fires after this guard and checks the
  -- exact active parent, key, organization, app, and channel scope.
  IF TG_OP = 'INSERT'
    AND pg_trigger_depth() > 1
    AND NEW.principal_type = public.rbac_principal_apikey()
    AND NEW.scope_type = public.rbac_scope_channel()
    AND NEW.is_direct IS FALSE
    AND NEW.parent_binding_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.roles
      WHERE roles.id = NEW.role_id
        AND roles.scope_type = public.rbac_scope_channel()
        AND roles.name = 'channel_preview'
        AND roles.is_assignable IS FALSE
    )
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    SELECT roles.priority_rank
    INTO v_old_role_priority
    FROM public.roles
    WHERE roles.id = OLD.role_id
      AND roles.scope_type = OLD.scope_type
    LIMIT 1;

    PERFORM public.assert_request_principal_rank(
      OLD.org_id,
      v_old_role_priority,
      'role_binding_old'
    );
  END IF;

  IF TG_OP <> 'DELETE' THEN
    SELECT roles.priority_rank
    INTO v_new_role_priority
    FROM public.roles
    WHERE roles.id = NEW.role_id
      AND roles.scope_type = NEW.scope_type
      AND roles.is_assignable IS TRUE
    LIMIT 1;

    IF v_new_role_priority IS NULL THEN
      PERFORM public.pg_log(
        'deny: ROLE_BINDING_ROLE_UNKNOWN',
        pg_catalog.jsonb_build_object('org_id', NEW.org_id, 'role_id', NEW.role_id)
      );
      RAISE EXCEPTION 'Admins cannot assign this role!';
    END IF;

    PERFORM public.assert_request_principal_rank(
      NEW.org_id,
      v_new_role_priority,
      'role_binding_new'
    );
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."accept_invitation_to_org"("org_id" "uuid") IS 'Accepts a pending org invite and creates the active RBAC binding. Kept for old clients.';
COMMENT ON FUNCTION "public"."prevent_role_binding_priority_escalation"() IS 'Prevents direct role binding inserts, updates, expiry changes, and deletes above the caller principal rank.';
