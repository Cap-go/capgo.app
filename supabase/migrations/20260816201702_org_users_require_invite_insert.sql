-- Require pending invites for authenticated org_users inserts.
-- Admins with org_update_user_roles could previously PostgREST-INSERT an
-- active membership (is_invite defaults false) for any existing users.id,
-- bypassing invite accept / captcha / email. org_users is metadata; real
-- rights come from role_bindings. Still close this table.

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

  IF TG_OP = 'INSERT'
    AND COALESCE(NEW.is_invite, false) IS NOT TRUE
  THEN
    PERFORM public.pg_log(
      'deny: ORG_USER_ACTIVE_INSERT',
      pg_catalog.jsonb_build_object('org_id', NEW.org_id, 'uid', v_actor_id)
    );
    RAISE EXCEPTION 'Admins cannot insert active org memberships!';
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

CREATE OR REPLACE TRIGGER "check_privileges"
  BEFORE INSERT OR UPDATE OF "user_id", "org_id", "rbac_role_name", "is_invite"
  ON "public"."org_users"
  FOR EACH ROW
  WHEN ((
    ("current_setting"('request.jwt.claim.role'::"text", true) = 'authenticated'::"text")
    AND COALESCE((NOT ("current_setting"('request.jwt.claim.email'::"text", true) = ANY (ARRAY['bot@capgo.app'::"text", 'test@capgo.app'::"text"]))), true)
  ))
  EXECUTE FUNCTION "public"."check_org_user_privileges"();
