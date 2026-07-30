-- Scope org-level membership lookups to org-level org_users rows.
--
-- public.org_users still carries legacy app-scoped and channel-scoped rows
-- (app_id / channel_id set). The RBAC invite path treated every row for a
-- (org_id, user_id) pair as the organization membership, which breaks orgs that
-- still have those legacy rows:
--   * accept_invitation_to_org picked an app/channel-scoped row, found no
--     matching org-scope role, and returned ROLE_NOT_FOUND forever, so the
--     invitee could never accept (surfaces as a stuck invitation).
--   * accept_invitation_to_org and update_org_invite_role_rbac also wrote the
--     org role name onto those scoped rows and cleared their is_invite flag.
--   * invite_user_to_org_rbac reported ALREADY_INVITED for a user who only had
--     an app-scoped row and no organization membership at all.
--   * get_org_members_rbac listed those scoped rows as pending org invitations.
--
-- private/accept_invitation.ts already filters app_id/channel_id when it does
-- the same work; this aligns the SQL paths with it.

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
    AND public.org_users.app_id IS NULL
    AND public.org_users.channel_id IS NULL
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
    AND public.org_users.is_invite IS TRUE
    AND public.org_users.app_id IS NULL
    AND public.org_users.channel_id IS NULL;

  RETURN 'OK';
END;
$$;

CREATE OR REPLACE FUNCTION "public"."invite_user_to_org_rbac"("email" character varying, "org_id" "uuid", "role_name" "text") RETURNS character varying
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  org record;
  invited_user record;
  current_record record;
  current_tmp_user record;
  role_id uuid;
  role_priority integer;
  caller_max_priority integer := 0;
  api_key_text text;
  api_key_row public.apikeys%ROWTYPE;
  v_granted_by uuid;
  v_principal_type text;
  v_principal_id uuid;
BEGIN
  SELECT * INTO org FROM public.orgs WHERE public.orgs.id = invite_user_to_org_rbac.org_id;
  IF org IS NULL THEN
    RETURN 'NO_ORG';
  END IF;

  SELECT r.id, r.priority_rank INTO role_id, role_priority
  FROM public.roles r
  WHERE r.name = invite_user_to_org_rbac.role_name
    AND r.scope_type = public.rbac_scope_org()
    AND r.is_assignable = true
  LIMIT 1;

  IF role_id IS NULL THEN
    RETURN 'ROLE_NOT_FOUND';
  END IF;

  SELECT public.get_apikey_header() INTO api_key_text;
  IF api_key_text IS NOT NULL THEN
    SELECT * INTO api_key_row FROM public.find_apikey_by_value(api_key_text) LIMIT 1;
    v_granted_by := api_key_row.user_id;
    v_principal_type := public.rbac_principal_apikey();
    v_principal_id := api_key_row.rbac_id;
  ELSE
    v_granted_by := auth.uid();
    v_principal_type := public.rbac_principal_user();
    v_principal_id := auth.uid();
  END IF;

  IF invite_user_to_org_rbac.role_name = public.rbac_role_org_super_admin() THEN
    IF NOT public.rbac_check_permission_direct(public.rbac_perm_org_update_user_roles(), auth.uid(), invite_user_to_org_rbac.org_id, NULL, NULL, api_key_text) THEN
      RETURN 'NO_RIGHTS';
    END IF;
  ELSE
    IF NOT public.rbac_check_permission_direct(public.rbac_perm_org_invite_user(), auth.uid(), invite_user_to_org_rbac.org_id, NULL, NULL, api_key_text) THEN
      RETURN 'NO_RIGHTS';
    END IF;
  END IF;

  IF v_principal_id IS NULL THEN
    RETURN 'NO_RIGHTS';
  END IF;

  SELECT COALESCE(MAX(r.priority_rank), 0) INTO caller_max_priority
  FROM public.role_bindings rb
  JOIN public.roles r
    ON r.id = rb.role_id
    AND r.scope_type = rb.scope_type
  WHERE rb.principal_type = v_principal_type
    AND rb.principal_id = v_principal_id
    AND rb.org_id = invite_user_to_org_rbac.org_id
    AND (rb.expires_at IS NULL OR rb.expires_at > now());

  IF caller_max_priority < role_priority THEN
    RETURN 'NO_RIGHTS';
  END IF;

  SELECT public.users.id INTO invited_user FROM public.users WHERE public.users.email = invite_user_to_org_rbac.email;

  IF invited_user IS NOT NULL THEN
    SELECT public.org_users.id INTO current_record
    FROM public.org_users
    WHERE public.org_users.user_id = invited_user.id
      AND public.org_users.org_id = invite_user_to_org_rbac.org_id
      AND public.org_users.app_id IS NULL
      AND public.org_users.channel_id IS NULL;

    IF current_record IS NOT NULL THEN
      RETURN 'ALREADY_INVITED';
    ELSE
      INSERT INTO public.org_users (user_id, org_id, rbac_role_name, is_invite)
      VALUES (invited_user.id, invite_user_to_org_rbac.org_id, invite_user_to_org_rbac.role_name, true);

      INSERT INTO public.role_bindings (
        principal_type, principal_id, role_id, scope_type, org_id,
        granted_by, granted_at, expires_at, reason, is_direct
      ) VALUES (
        public.rbac_principal_user(), invited_user.id, role_id, public.rbac_scope_org(), invite_user_to_org_rbac.org_id,
        COALESCE(v_granted_by, invited_user.id), now(), now() - INTERVAL '1 second', 'Pending invitation', true
      ) ON CONFLICT DO NOTHING;

      RETURN 'OK';
    END IF;
  ELSE
    SELECT * INTO current_tmp_user
    FROM public.tmp_users
    WHERE public.tmp_users.email = invite_user_to_org_rbac.email
      AND public.tmp_users.org_id = invite_user_to_org_rbac.org_id;

    IF current_tmp_user IS NOT NULL THEN
      IF current_tmp_user.cancelled_at IS NOT NULL THEN
        IF current_tmp_user.cancelled_at > (CURRENT_TIMESTAMP - INTERVAL '3 hours') THEN
          RETURN 'TOO_RECENT_INVITATION_CANCELATION';
        ELSE
          RETURN 'NO_EMAIL';
        END IF;
      ELSE
        RETURN 'ALREADY_INVITED';
      END IF;
    ELSE
      RETURN 'NO_EMAIL';
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."update_org_invite_role_rbac"("p_org_id" "uuid", "p_user_id" "uuid", "p_new_role_name" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  role_id uuid;
BEGIN
  SELECT id INTO role_id
  FROM public.roles r
  WHERE r.name = p_new_role_name
    AND r.scope_type = public.rbac_scope_org()
    AND r.is_assignable = true
  LIMIT 1;

  IF role_id IS NULL THEN
    RAISE EXCEPTION 'ROLE_NOT_FOUND';
  END IF;

  IF p_new_role_name = public.rbac_role_org_super_admin() THEN
    IF NOT public.rbac_check_permission_request(public.rbac_perm_org_update_user_roles(), p_org_id, NULL::character varying, NULL::bigint) THEN
      RAISE EXCEPTION 'NO_PERMISSION_TO_UPDATE_ROLES';
    END IF;
  ELSE
    IF NOT public.rbac_check_permission_request(public.rbac_perm_org_invite_user(), p_org_id, NULL::character varying, NULL::bigint) THEN
      RAISE EXCEPTION 'NO_PERMISSION_TO_UPDATE_ROLES';
    END IF;
  END IF;

  UPDATE public.org_users
  SET rbac_role_name = p_new_role_name,
      updated_at = now()
  WHERE org_id = p_org_id
    AND user_id = p_user_id
    AND is_invite IS TRUE
    AND app_id IS NULL
    AND channel_id IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_INVITATION';
  END IF;

  RETURN 'OK';
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_org_members_rbac"("p_org_id" "uuid") RETURNS TABLE("user_id" "uuid", "email" character varying, "image_url" character varying, "role_name" "text", "role_id" "uuid", "binding_id" "uuid", "granted_at" timestamp with time zone, "is_invite" boolean, "is_tmp" boolean, "org_user_id" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF NOT public.rbac_check_permission_request(
    public.rbac_perm_org_read_members(),
    p_org_id,
    NULL::character varying,
    NULL::bigint
  ) THEN
    RAISE EXCEPTION 'NO_PERMISSION_TO_VIEW_MEMBERS';
  END IF;

  RETURN QUERY
  WITH rbac_members AS (
    SELECT
      u.id AS user_id,
      u.email,
      u.image_url,
      r.name AS role_name,
      rb.role_id,
      rb.id AS binding_id,
      rb.granted_at,
      false AS is_invite,
      false AS is_tmp,
      NULL::bigint AS org_user_id
    FROM public.users u
    INNER JOIN public.role_bindings rb ON rb.principal_id = u.id
      AND rb.principal_type = public.rbac_principal_user()
      AND rb.scope_type = public.rbac_scope_org()
      AND rb.org_id = p_org_id
      AND (rb.expires_at IS NULL OR rb.expires_at > now())
    INNER JOIN public.roles r ON rb.role_id = r.id
      AND r.scope_type = rb.scope_type
    WHERE r.scope_type = public.rbac_scope_org()
      AND r.name LIKE 'org_%'
  ),
  pending_user_invites AS (
    SELECT
      u.id AS user_id,
      u.email,
      u.image_url,
      COALESCE(ou.rbac_role_name, public.rbac_role_org_member()) AS role_name,
      NULL::uuid AS role_id,
      NULL::uuid AS binding_id,
      ou.created_at AS granted_at,
      true AS is_invite,
      false AS is_tmp,
      ou.id AS org_user_id
    FROM public.org_users ou
    INNER JOIN public.users u ON u.id = ou.user_id
    WHERE ou.org_id = p_org_id
      AND ou.is_invite IS TRUE
      AND ou.app_id IS NULL
      AND ou.channel_id IS NULL
  ),
  tmp_invites AS (
    SELECT
      tmp.future_uuid AS user_id,
      tmp.email,
      ''::character varying AS image_url,
      tmp.rbac_role_name AS role_name,
      NULL::uuid AS role_id,
      NULL::uuid AS binding_id,
      GREATEST(tmp.updated_at, tmp.created_at) AS granted_at,
      true AS is_invite,
      true AS is_tmp,
      NULL::bigint AS org_user_id
    FROM public.tmp_users tmp
    WHERE tmp.org_id = p_org_id
      AND tmp.cancelled_at IS NULL
      AND GREATEST(tmp.updated_at, tmp.created_at) > (CURRENT_TIMESTAMP - INTERVAL '7 days')
  )
  SELECT *
  FROM (
    SELECT * FROM rbac_members
    UNION ALL
    SELECT * FROM pending_user_invites
    UNION ALL
    SELECT * FROM tmp_invites
  ) AS combined
  ORDER BY is_tmp ASC, is_invite ASC, email ASC;
END;
$$;

-- A scoped legacy row is not evidence that the caller has an organization
-- invitation. Keep this as a separate guard so an old contaminated row cannot
-- use the invite-acceptance exception in prevent_role_binding_priority_escalation.
CREATE OR REPLACE FUNCTION public.prevent_scoped_invite_role_acceptance() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF public.is_internal_request_role(public.current_request_role()) THEN
    RETURN NEW;
  END IF;

  IF NEW.principal_type = public.rbac_principal_user()
    AND NEW.principal_id = auth.uid()
    AND NEW.scope_type = public.rbac_scope_org()
    AND NEW.reason = 'Accepted invitation'
    AND NEW.app_id IS NULL
    AND NEW.bundle_id IS NULL
    AND NEW.channel_id IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.org_users ou
      JOIN public.roles r
        ON r.name = ou.rbac_role_name
        AND r.scope_type = public.rbac_scope_org()
      WHERE ou.user_id = NEW.principal_id
        AND ou.org_id = NEW.org_id
        AND ou.is_invite IS TRUE
        AND ou.app_id IS NULL
        AND ou.channel_id IS NULL
        AND r.id = NEW.role_id
    )
  THEN
    PERFORM public.pg_log(
      'deny: SCOPED_INVITE_ROLE_ACCEPTANCE',
      pg_catalog.jsonb_build_object('org_id', NEW.org_id, 'uid', auth.uid())
    );
    RAISE EXCEPTION 'Admins cannot elevate privileges!';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.prevent_scoped_invite_role_acceptance() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.prevent_scoped_invite_role_acceptance() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prevent_scoped_invite_role_acceptance() TO service_role;

DROP TRIGGER IF EXISTS prevent_scoped_invite_role_acceptance ON public.role_bindings;
CREATE TRIGGER prevent_scoped_invite_role_acceptance
BEFORE INSERT ON public.role_bindings
FOR EACH ROW
EXECUTE FUNCTION public.prevent_scoped_invite_role_acceptance();

-- Scope columns are part of a membership row's identity. External callers must
-- not turn an app/channel row into an organization invitation after the fact.
CREATE OR REPLACE FUNCTION public.prevent_org_user_scope_mutation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF public.is_internal_request_role(public.current_request_role()) THEN
    RETURN NEW;
  END IF;

  IF NEW.app_id IS DISTINCT FROM OLD.app_id
    OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
  THEN
    PERFORM public.pg_log(
      'deny: ORG_USER_SCOPE_MOVE',
      pg_catalog.jsonb_build_object('org_id', NEW.org_id, 'uid', auth.uid())
    );
    RAISE EXCEPTION 'Admins cannot move org membership scopes!';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.prevent_org_user_scope_mutation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.prevent_org_user_scope_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prevent_org_user_scope_mutation() TO service_role;

DROP TRIGGER IF EXISTS prevent_org_user_scope_mutation ON public.org_users;
CREATE TRIGGER prevent_org_user_scope_mutation
BEFORE UPDATE OF app_id, channel_id ON public.org_users
FOR EACH ROW
EXECUTE FUNCTION public.prevent_org_user_scope_mutation();

COMMENT ON FUNCTION public.prevent_scoped_invite_role_acceptance() IS 'Requires an org-level pending membership row before an authenticated user can insert an accepted org-role binding.';
COMMENT ON FUNCTION public.prevent_org_user_scope_mutation() IS 'Prevents external callers from changing an org_users row between org, app, and channel scopes.';
COMMENT ON FUNCTION "public"."accept_invitation_to_org"("org_id" "uuid") IS 'Accepts a pending org invite and creates the active RBAC binding. Kept for old clients.';
