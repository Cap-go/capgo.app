-- public.users.email mirrors the account's auth email. Client-facing roles may
-- still insert/update their own profile row, but the email column is always
-- taken from auth.users so it cannot drift from the address the account signed
-- up with (or confirmed later through supabase.auth.updateUser). Backend and
-- service-role writes are unaffected.
CREATE OR REPLACE FUNCTION public.enforce_users_email_from_auth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_auth_email text;
  v_claim_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
BEGIN
  -- SECURITY DEFINER makes current_user the owner, so detect client writes
  -- from the SET ROLE value and the request JWT role instead. This also covers
  -- user-facing SECURITY DEFINER wrappers.
  IF pg_catalog.current_setting('role', true) IN ('authenticated', 'anon')
    OR v_claim_role IN ('authenticated', 'anon') THEN
    SELECT au.email INTO v_auth_email
    FROM auth.users AS au
    WHERE au.id = NEW.id;

    IF v_auth_email IS NULL OR v_auth_email = '' THEN
      IF TG_OP = 'UPDATE' THEN
        NEW.email := OLD.email;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'USER_EMAIL_NOT_AVAILABLE' USING ERRCODE = '42501';
    END IF;

    NEW.email := v_auth_email;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_users_email_from_auth() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_users_email_from_auth() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_users_email_from_auth() TO service_role;

CREATE TRIGGER enforce_users_email_from_auth
BEFORE INSERT OR UPDATE OF email ON public.users
FOR EACH ROW EXECUTE FUNCTION public.enforce_users_email_from_auth();

-- Realign profile emails that drifted from the auth email. The on_user_update
-- webhook is paused for this one-off statement so the previous (unverified)
-- profile address is not pushed into Bento email-change/preference syncs.
ALTER TABLE public.users DISABLE TRIGGER on_user_update;

UPDATE public.users AS u
SET email = au.email
FROM auth.users AS au
WHERE au.id = u.id
  AND au.email IS NOT NULL
  AND au.email <> ''
  AND u.email IS DISTINCT FROM au.email;

ALTER TABLE public.users ENABLE TRIGGER on_user_update;

-- Resolve existing-account invitees from the confirmed auth email instead of
-- the profile row. Unknown or unconfirmed addresses fall through to the
-- email-based (tmp_users) invitation flow, which requires mailbox access.
CREATE OR REPLACE FUNCTION public.invite_user_to_org_rbac(email character varying, org_id uuid, role_name text)
RETURNS character varying
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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

  SELECT public.users.id INTO invited_user
  FROM public.users
  JOIN auth.users AS au
    ON au.id = public.users.id
  WHERE au.email = invite_user_to_org_rbac.email
    AND au.email_confirmed_at IS NOT NULL
  LIMIT 1;

  IF invited_user IS NOT NULL THEN
    SELECT public.org_users.id INTO current_record
    FROM public.org_users
    WHERE public.org_users.user_id = invited_user.id
      AND public.org_users.org_id = invite_user_to_org_rbac.org_id;

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
