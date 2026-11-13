-- Close paths must queue Bento field syncs by invitee email even when
-- bento_email was not committed yet. accept_tmp_user_invitation must not
-- insert a pending org_users row that queues a duplicate existing-user invite.

CREATE OR REPLACE FUNCTION public.trigger_queue_org_invitation_bento_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_bento_email text;
    v_sent_at timestamptz;
    v_invitee_email text;
    v_sync_email text;
    v_invite_id bigint;
BEGIN
    IF TG_TABLE_NAME = 'tmp_users' THEN
        v_invite_id := OLD.id;
        v_invitee_email := pg_catalog.lower(pg_catalog.btrim(OLD.email));
        SELECT
            request.bento_email,
            request.sent_at
        INTO v_bento_email, v_sent_at
        FROM public.org_invitation_email_requests AS request
        WHERE request.tmp_user_id = v_invite_id
        FOR UPDATE;
    ELSIF TG_TABLE_NAME = 'org_users' THEN
        v_invite_id := OLD.id;
        SELECT pg_catalog.lower(pg_catalog.btrim(users.email))
        INTO v_invitee_email
        FROM public.users
        WHERE users.id = OLD.user_id;
        SELECT
            request.bento_email,
            request.sent_at
        INTO v_bento_email, v_sent_at
        FROM public.org_invitation_email_requests AS request
        WHERE request.org_user_id = v_invite_id
        FOR UPDATE;
    END IF;

    v_sync_email := pg_catalog.lower(
        pg_catalog.btrim(pg_catalog.coalesce(v_bento_email, v_invitee_email))
    );

    IF v_sync_email IS NOT NULL
        AND (v_bento_email IS NOT NULL OR v_sent_at IS NOT NULL)
    THEN
        PERFORM public.queue_org_invitation_bento_sync(v_sync_email);
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

ALTER FUNCTION public.trigger_queue_org_invitation_bento_sync()
OWNER TO postgres;
REVOKE ALL ON FUNCTION public.trigger_queue_org_invitation_bento_sync()
FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_queue_org_invitation_bento_sync()
TO service_role;

CREATE OR REPLACE FUNCTION public.queue_org_invitation_email(
    p_kind text,
    p_invite_id bigint,
    p_inviter_id uuid DEFAULT null
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_generation uuid;
    v_previous_bento_email text;
    v_previous_sent_at timestamptz;
    v_previous_sync_email text;
    v_invitee_email text;
BEGIN
    IF p_kind = 'existing' THEN
        PERFORM 1 FROM public.org_users AS invitation
        WHERE invitation.id = p_invite_id
            AND invitation.is_invite
            AND invitation.app_id IS NULL
            AND invitation.channel_id IS NULL;
        IF NOT FOUND THEN
            RETURN 'NOT_PENDING';
        END IF;

        SELECT request.bento_email, request.sent_at
        INTO v_previous_bento_email, v_previous_sent_at
        FROM public.org_invitation_email_requests AS request
        WHERE request.org_user_id = p_invite_id
        FOR UPDATE;

        SELECT pg_catalog.lower(pg_catalog.btrim(users.email))
        INTO v_invitee_email
        FROM public.org_users AS invitation
        JOIN public.users ON users.id = invitation.user_id
        WHERE invitation.id = p_invite_id;

        INSERT INTO public.org_invitation_email_requests AS request (
            org_user_id, invited_by_user_id
        ) VALUES (p_invite_id, p_inviter_id)
        ON CONFLICT (org_user_id) DO UPDATE
        SET id = EXCLUDED.id,
            invited_by_user_id = EXCLUDED.invited_by_user_id,
            requested_at = pg_catalog.clock_timestamp(),
            sent_at = NULL,
            message_id = NULL,
            bento_synced_at = NULL,
            bento_email = NULL
        WHERE request.requested_at <= pg_catalog.clock_timestamp() - interval '5 minutes'
        RETURNING id INTO v_generation;
    ELSIF p_kind = 'new' THEN
        PERFORM 1 FROM public.tmp_users AS invitation
        WHERE invitation.id = p_invite_id AND invitation.cancelled_at IS NULL;
        IF NOT FOUND THEN
            RETURN 'NOT_PENDING';
        END IF;

        SELECT request.bento_email, request.sent_at
        INTO v_previous_bento_email, v_previous_sent_at
        FROM public.org_invitation_email_requests AS request
        WHERE request.tmp_user_id = p_invite_id
        FOR UPDATE;

        SELECT pg_catalog.lower(pg_catalog.btrim(invitation.email))
        INTO v_invitee_email
        FROM public.tmp_users AS invitation
        WHERE invitation.id = p_invite_id;

        INSERT INTO public.org_invitation_email_requests AS request (
            tmp_user_id, invited_by_user_id
        ) VALUES (p_invite_id, p_inviter_id)
        ON CONFLICT (tmp_user_id) DO UPDATE
        SET id = EXCLUDED.id,
            invited_by_user_id = EXCLUDED.invited_by_user_id,
            requested_at = pg_catalog.clock_timestamp(),
            sent_at = NULL,
            message_id = NULL,
            bento_synced_at = NULL,
            bento_email = NULL
        WHERE request.requested_at <= pg_catalog.clock_timestamp() - interval '5 minutes'
        RETURNING id INTO v_generation;
    ELSE
        RETURN 'NOT_PENDING';
    END IF;

    IF v_generation IS NULL THEN
        RETURN 'COOLDOWN';
    END IF;

    PERFORM pgmq.send(
        'send_email',
        pg_catalog.jsonb_build_object(
            'function_name', 'send_email',
            'function_type', 'cloudflare',
            'payload', pg_catalog.jsonb_build_object('org_invitation_id', v_generation)
        )
    );

    v_previous_sync_email := pg_catalog.lower(
        pg_catalog.btrim(
            pg_catalog.coalesce(v_previous_bento_email, v_invitee_email)
        )
    );
    IF v_previous_sync_email IS NOT NULL
        AND (
            v_previous_bento_email IS NOT NULL
            OR v_previous_sent_at IS NOT NULL
        )
    THEN
        PERFORM public.queue_org_invitation_bento_sync(v_previous_sync_email);
    END IF;
    RETURN 'QUEUED';
END;
$$;

ALTER FUNCTION public.queue_org_invitation_email(text, bigint, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.queue_org_invitation_email(text, bigint, uuid) FROM public,
anon,
authenticated;
GRANT EXECUTE ON FUNCTION public.queue_org_invitation_email(text, bigint, uuid)
TO service_role;

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
    v_inviter_id uuid;
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

    v_inviter_id := v_invite.invited_by_user_id;
    IF v_inviter_id IS NULL THEN
        RETURN 'INVITER_NOT_FOUND';
    END IF;

    PERFORM public.assert_principal_can_grant_org_role(
        v_invite.org_id,
        v_inviter_id,
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
        v_inviter_id,
        pg_catalog.now(),
        'Accepted invitation',
        true
    );

    IF NOT EXISTS (
        SELECT 1
        FROM public.org_users
        WHERE org_users.user_id = p_user_id
            AND org_users.org_id = v_invite.org_id
            AND org_users.app_id IS NULL
            AND org_users.channel_id IS NULL
    ) THEN
        INSERT INTO public.org_users (user_id, org_id, rbac_role_name, is_invite)
        VALUES (p_user_id, v_invite.org_id, v_rbac_role_name, false);
    ELSE
        UPDATE public.org_users
        SET is_invite = false,
            rbac_role_name = v_rbac_role_name,
            updated_at = pg_catalog.now()
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
            AND org_users.is_invite IS FALSE
    ) THEN
        RETURN 'MEMBERSHIP_NOT_FINALIZED';
    END IF;

    DELETE FROM public.tmp_users
    WHERE tmp_users.id = v_invite.id;

    RETURN 'OK';
END;
$$;

ALTER FUNCTION public.accept_tmp_user_invitation(text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.accept_tmp_user_invitation(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_tmp_user_invitation(text, uuid) TO service_role;
