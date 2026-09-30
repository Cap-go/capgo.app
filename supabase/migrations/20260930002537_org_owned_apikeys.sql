-- Org-owned (shared) API keys.
--
-- A shared key belongs to exactly one organization (apikeys.owner_org_id).
-- It keeps a user_id for attribution only: the key's rights come solely from
-- its own role_bindings, which must stay inside the owner org. Shared keys are
-- always hashed, never carry global permissions, and are managed by anyone
-- holding org.manage_apikeys in the owner org instead of by their creator.
-- When the attributed user leaves the org or deletes their account, the key is
-- reassigned to a durable org super admin (or deleted when none exists), so
-- CI keys survive staff changes without any change in the key's privileges.
-- Multi-org keys stay personal and keep the existing user-owned lifecycle.

ALTER TABLE public.apikeys
ADD COLUMN owner_org_id uuid;

ALTER TABLE public.apikeys
ADD CONSTRAINT apikeys_owner_org_id_fkey
FOREIGN KEY (owner_org_id) REFERENCES public.orgs (id) ON DELETE CASCADE;

ALTER TABLE public.apikeys
ADD CONSTRAINT apikeys_org_owned_requires_hash
CHECK (owner_org_id IS NULL OR key_hash IS NOT NULL);

CREATE INDEX apikeys_owner_org_id_idx
ON public.apikeys USING btree (owner_org_id)
WHERE owner_org_id IS NOT NULL;

COMMENT ON COLUMN public.apikeys.owner_org_id IS
'When set, the key is shared with (owned by) this organization: bindings are limited to this org, it is managed through org.manage_apikeys, and user_id is attribution only.';

-- Ownership is decided at creation and never converted afterwards.
CREATE OR REPLACE FUNCTION public.apikeys_owner_org_id_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.owner_org_id IS DISTINCT FROM OLD.owner_org_id THEN
    RAISE EXCEPTION 'APIKEY_OWNER_ORG_IMMUTABLE'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.apikeys_owner_org_id_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apikeys_owner_org_id_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apikeys_owner_org_id_immutable() FROM anon, authenticated;

CREATE TRIGGER apikeys_owner_org_id_immutable
BEFORE UPDATE OF owner_org_id ON public.apikeys
FOR EACH ROW EXECUTE FUNCTION public.apikeys_owner_org_id_immutable();

-- Shared keys can only hold role bindings inside their owner org.
CREATE OR REPLACE FUNCTION public.enforce_org_owned_apikey_binding_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.principal_type = public.rbac_principal_apikey()
    AND EXISTS (
      SELECT 1
      FROM public.apikeys
      WHERE apikeys.rbac_id = NEW.principal_id
        AND apikeys.owner_org_id IS NOT NULL
        AND apikeys.owner_org_id IS DISTINCT FROM NEW.org_id
    )
  THEN
    RAISE EXCEPTION 'ORG_OWNED_APIKEY_BINDING_OUTSIDE_OWNER_ORG'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_org_owned_apikey_binding_org() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_org_owned_apikey_binding_org() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_org_owned_apikey_binding_org() FROM anon, authenticated;

CREATE TRIGGER enforce_org_owned_apikey_binding_org
BEFORE INSERT OR UPDATE OF principal_type, principal_id, org_id ON public.role_bindings
FOR EACH ROW EXECUTE FUNCTION public.enforce_org_owned_apikey_binding_org();

-- Global permissions (org.create) create new orgs outside the owner org.
CREATE OR REPLACE FUNCTION public.deny_org_owned_apikey_global_permissions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.apikeys
    WHERE apikeys.rbac_id = NEW.apikey_rbac_id
      AND apikeys.owner_org_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'ORG_OWNED_APIKEY_GLOBAL_PERMISSION_DENIED'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.deny_org_owned_apikey_global_permissions() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.deny_org_owned_apikey_global_permissions() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deny_org_owned_apikey_global_permissions() FROM anon, authenticated;

CREATE TRIGGER deny_org_owned_apikey_global_permissions
BEFORE INSERT OR UPDATE ON public.apikey_global_permissions
FOR EACH ROW EXECUTE FUNCTION public.deny_org_owned_apikey_global_permissions();

-- Durable successor for attribution: the oldest non-expiring org super admin
-- (direct or through a group) other than the departing user.
CREATE OR REPLACE FUNCTION public.org_owned_apikey_successor_user_id(
  p_org_id uuid,
  p_excluded_user_id uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT candidates.user_id
  FROM (
    SELECT bindings.principal_id AS user_id, bindings.granted_at
    FROM public.role_bindings AS bindings
    INNER JOIN public.roles AS roles
      ON roles.id = bindings.role_id
      AND roles.scope_type = bindings.scope_type
    WHERE bindings.org_id = p_org_id
      AND bindings.principal_type = public.rbac_principal_user()
      AND bindings.principal_id <> p_excluded_user_id
      AND bindings.scope_type = public.rbac_scope_org()
      AND bindings.expires_at IS NULL
      AND roles.name = public.rbac_role_org_super_admin()

    UNION

    SELECT members.user_id, bindings.granted_at
    FROM public.role_bindings AS bindings
    INNER JOIN public.roles AS roles
      ON roles.id = bindings.role_id
      AND roles.scope_type = bindings.scope_type
    INNER JOIN public.groups AS groups
      ON groups.id = bindings.principal_id
      AND groups.org_id = bindings.org_id
    INNER JOIN public.group_members AS members
      ON members.group_id = groups.id
    WHERE bindings.org_id = p_org_id
      AND bindings.principal_type = public.rbac_principal_group()
      AND bindings.scope_type = public.rbac_scope_org()
      AND bindings.expires_at IS NULL
      AND roles.name = public.rbac_role_org_super_admin()
      AND members.user_id <> p_excluded_user_id
  ) AS candidates
  ORDER BY candidates.granted_at ASC, candidates.user_id ASC
  LIMIT 1
$$;

ALTER FUNCTION public.org_owned_apikey_successor_user_id(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.org_owned_apikey_successor_user_id(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.org_owned_apikey_successor_user_id(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.org_owned_apikey_successor_user_id(uuid, uuid) TO service_role;

-- Reassigns (attribution only) or deletes the shared keys attributed to a
-- departing user. Only user_id changes: bindings, secret, and expiry stay the
-- same, so the key's effective privileges never change on transfer.
CREATE OR REPLACE FUNCTION public.transfer_org_owned_apikeys_from_user(
  p_user_id uuid,
  p_org_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id uuid;
  v_successor_id uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;

  FOR v_org_id IN
    SELECT DISTINCT apikeys.owner_org_id
    FROM public.apikeys
    WHERE apikeys.user_id = p_user_id
      AND apikeys.owner_org_id IS NOT NULL
      AND (p_org_id IS NULL OR apikeys.owner_org_id = p_org_id)
  LOOP
    v_successor_id := public.org_owned_apikey_successor_user_id(v_org_id, p_user_id);

    IF v_successor_id IS NULL THEN
      DELETE FROM public.apikeys
      WHERE apikeys.user_id = p_user_id
        AND apikeys.owner_org_id = v_org_id;
    ELSE
      UPDATE public.apikeys
      SET user_id = v_successor_id
      WHERE apikeys.user_id = p_user_id
        AND apikeys.owner_org_id = v_org_id;
    END IF;
  END LOOP;
END;
$$;

ALTER FUNCTION public.transfer_org_owned_apikeys_from_user(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transfer_org_owned_apikeys_from_user(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transfer_org_owned_apikeys_from_user(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_org_owned_apikeys_from_user(uuid, uuid) TO service_role;

-- Covers every user deletion path, including direct auth.users cascades.
CREATE OR REPLACE FUNCTION public.transfer_org_owned_apikeys_before_user_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.transfer_org_owned_apikeys_from_user(OLD.id);
  RETURN OLD;
END;
$$;

ALTER FUNCTION public.transfer_org_owned_apikeys_before_user_delete() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transfer_org_owned_apikeys_before_user_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transfer_org_owned_apikeys_before_user_delete() FROM anon, authenticated;

CREATE TRIGGER transfer_org_owned_apikeys_before_user_delete
BEFORE DELETE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.transfer_org_owned_apikeys_before_user_delete();

-- Statement-level helper for the shared-key RLS policies below.
CREATE OR REPLACE FUNCTION public.org_owned_apikey_manageable_org_ids()
RETURNS uuid []
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    public.rbac_org_ids_for_permission(public.rbac_perm_org_manage_apikeys()),
    '{}'::uuid[]
  )
$$;

ALTER FUNCTION public.org_owned_apikey_manageable_org_ids() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.org_owned_apikey_manageable_org_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.org_owned_apikey_manageable_org_ids() FROM anon;
GRANT EXECUTE ON FUNCTION public.org_owned_apikey_manageable_org_ids() TO authenticated, service_role;

COMMENT ON FUNCTION public.org_owned_apikey_manageable_org_ids() IS
'Org ids where the JWT caller holds org.manage_apikeys. Invoked once per apikeys statement by the shared-key RLS policies.';

-- Personal keys stay managed by their owner. Shared keys are managed through
-- org.manage_apikeys in the owner org; their user_id grants nothing. One
-- permissive policy per operation keeps RLS evaluation single-pass.
DROP POLICY IF EXISTS "Allow owner to select own apikeys" ON public.apikeys;
DROP POLICY IF EXISTS "Allow owner to delete own apikeys" ON public.apikeys;

CREATE POLICY "Allow owner or org key managers to select apikeys"
ON public.apikeys
FOR SELECT
TO authenticated
USING (
  (
    owner_org_id IS NULL
    AND user_id = (SELECT auth.uid())
  )
  OR owner_org_id = ANY(
    COALESCE((SELECT public.org_owned_apikey_manageable_org_ids()), '{}'::uuid[])
  )
);

CREATE POLICY "Allow owner or org key managers to delete apikeys"
ON public.apikeys
FOR DELETE
TO authenticated
USING (
  (
    owner_org_id IS NULL
    AND user_id = (SELECT auth.uid())
  )
  OR owner_org_id = ANY(
    COALESCE((SELECT public.org_owned_apikey_manageable_org_ids()), '{}'::uuid[])
  )
);

-- Shared keys may only be bound inside their owner org, independent of who
-- the attributed user is.
CREATE OR REPLACE FUNCTION rbac_internal.role_binding_principal_allowed_for_org(
  p_principal_type text,
  p_principal_id uuid,
  p_org_id uuid,
  p_scope_type text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner_org_id uuid;
BEGIN
  -- First org-scope user binding is allowed without a prior membership check.
  IF p_principal_type = public.rbac_principal_user()
    AND p_scope_type = public.rbac_scope_org()
  THEN
    RETURN true;
  END IF;

  -- Serialize with org membership revocation (org_users DELETE uses lock_rbac_orgs)
  -- so scoped bindings cannot commit after concurrent membership removal.
  PERFORM public.lock_rbac_orgs(p_org_id);

  IF p_principal_type = public.rbac_principal_user()
    AND p_scope_type IN (
      public.rbac_scope_app(),
      public.rbac_scope_channel(),
      public.rbac_scope_bundle()
    )
  THEN
    RETURN EXISTS (
      SELECT 1
      FROM public.role_bindings AS membership
      WHERE membership.principal_type = public.rbac_principal_user()
        AND membership.principal_id = p_principal_id
        AND membership.scope_type = public.rbac_scope_org()
        AND membership.org_id = p_org_id
        AND (
          membership.expires_at IS NULL
          OR membership.expires_at > pg_catalog.now()
        )
    );
  END IF;

  IF p_principal_type = public.rbac_principal_group()
  THEN
    RETURN EXISTS (
      SELECT 1
      FROM public.groups
      WHERE groups.id = p_principal_id
        AND groups.org_id = p_org_id
    );
  END IF;

  IF p_principal_type = public.rbac_principal_apikey()
  THEN
    SELECT apikeys.owner_org_id
    INTO v_owner_org_id
    FROM public.apikeys
    WHERE apikeys.rbac_id = p_principal_id;

    IF v_owner_org_id IS NOT NULL THEN
      RETURN v_owner_org_id = p_org_id;
    END IF;

    RETURN EXISTS (
      SELECT 1
      FROM public.role_bindings AS membership
      WHERE membership.principal_type = public.rbac_principal_apikey()
        AND membership.principal_id = p_principal_id
        AND membership.scope_type = public.rbac_scope_org()
        AND membership.org_id = p_org_id
        AND (
          membership.expires_at IS NULL
          OR membership.expires_at > pg_catalog.now()
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.apikeys
      WHERE apikeys.rbac_id = p_principal_id
        AND EXISTS (
          SELECT 1
          FROM public.role_bindings AS owner_membership
          WHERE owner_membership.principal_type = public.rbac_principal_user()
            AND owner_membership.principal_id = apikeys.user_id
            AND owner_membership.scope_type = public.rbac_scope_org()
            AND owner_membership.org_id = p_org_id
            AND (
              owner_membership.expires_at IS NULL
              OR owner_membership.expires_at > pg_catalog.now()
            )
        )
    );
  END IF;

  RETURN false;
END;
$$;

COMMENT ON FUNCTION rbac_internal.role_binding_principal_allowed_for_org(text, uuid, uuid, text) IS
'RLS helper: target principal may receive a role_binding on this org. User org-scope is always allowed (first membership). User app/channel/bundle requires a non-expired org-scope binding. Group must belong to the org. Org-owned apikeys may only be bound inside their owner org. Personal apikeys must have an org-scope binding or an owner with org-scope membership. Acquires lock_rbac_orgs before membership EXISTS checks to serialize with concurrent org membership revocation.';

-- A shared key reads org_users only for its owner org, never for the other
-- orgs of its attributed user.
CREATE OR REPLACE FUNCTION public.org_member_readable_org_ids()
RETURNS uuid []
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_api_key_text text;
  v_api_key public.apikeys%ROWTYPE;
BEGIN
  SELECT auth.uid() INTO v_user_id;

  IF v_user_id IS NULL THEN
    SELECT public.get_apikey_header() INTO v_api_key_text;

    IF v_api_key_text IS NULL THEN
      RETURN '{}'::uuid[];
    END IF;

    SELECT *
    INTO v_api_key
    FROM public.find_apikey_by_value(v_api_key_text)
    LIMIT 1;

    IF v_api_key.id IS NULL OR public.is_apikey_expired(v_api_key.expires_at) THEN
      RETURN '{}'::uuid[];
    END IF;

    IF v_api_key.owner_org_id IS NOT NULL THEN
      IF v_api_key.owner_org_id = ANY(
        COALESCE((SELECT public.orgs_readable_org_ids()), '{}'::uuid[])
      ) THEN
        RETURN ARRAY[v_api_key.owner_org_id];
      END IF;

      RETURN '{}'::uuid[];
    END IF;

    v_user_id := v_api_key.user_id;
  END IF;

  RETURN (
    SELECT COALESCE(array_agg(DISTINCT org_users.org_id), '{}'::uuid[])
    FROM public.org_users
    WHERE org_users.user_id = v_user_id
      AND org_users.org_id = ANY(
        COALESCE((SELECT public.orgs_readable_org_ids()), '{}'::uuid[])
      )
  );
END;
$$;

-- Shared keys rotate through the API, which also checks that the caller holds
-- every permission of the key. Keep the compatibility RPC personal-only.
CREATE OR REPLACE FUNCTION public.regenerate_hashed_apikey(p_apikey_id bigint)
RETURNS public.apikeys
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_target public.apikeys%ROWTYPE;
  v_org_id uuid;
  v_has_org_binding boolean := false;
  v_caller_apikey text;
BEGIN
  v_user_id := public.request_actor_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No authentication provided';
  END IF;

  SELECT *
  INTO v_target
  FROM public.apikeys
  WHERE public.apikeys.id = p_apikey_id
    AND public.apikeys.user_id = v_user_id
    AND public.apikeys.owner_org_id IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'apikey_not_found'
      USING ERRCODE = 'P0002';
  END IF;

  -- Serialize binding mutations and rotation for this API-key principal.
  PERFORM public.lock_rbac_apikey_principal(v_target.rbac_id);

  -- Prefer the request capgkey so a read-only key cannot inherit the owner's
  -- user-level manage_apikeys. JWT callers still resolve as the user principal
  -- inside rbac_check_permission_direct.
  v_caller_apikey := public.get_apikey_header();

  FOR v_org_id IN
    SELECT DISTINCT role_bindings.org_id
    FROM public.role_bindings
    WHERE role_bindings.principal_type = public.rbac_principal_apikey()
      AND role_bindings.principal_id = v_target.rbac_id
      AND role_bindings.org_id IS NOT NULL
      AND (
        role_bindings.expires_at IS NULL
        OR role_bindings.expires_at > pg_catalog.now()
      )
  LOOP
    v_has_org_binding := true;
    IF NOT public.rbac_check_permission_direct(
      public.rbac_perm_org_manage_apikeys(),
      v_user_id,
      v_org_id,
      NULL::character varying,
      NULL::bigint,
      v_caller_apikey
    ) THEN
      RAISE EXCEPTION 'PERMISSION_DENIED_MANAGE_APIKEYS'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- Unbound keys have no org to authorize against. Deny instead of treating
  -- "no bindings" as an empty all-pass.
  IF NOT v_has_org_binding THEN
    RAISE EXCEPTION 'PERMISSION_DENIED_MANAGE_APIKEYS'
      USING ERRCODE = '42501';
  END IF;

  RETURN public.regenerate_hashed_apikey_for_user(p_apikey_id, v_user_id);
END;
$$;

-- Member removal: shared keys of the owner org move to a successor instead of
-- losing their bindings. Personal keys keep the existing cleanup.
CREATE OR REPLACE FUNCTION public.check_if_org_can_exist()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF public.is_org_delete_cascade(OLD.org_id) THEN
    RETURN OLD;
  END IF;

  IF OLD.app_id IS NOT NULL OR OLD.channel_id IS NOT NULL THEN
    RETURN OLD;
  END IF;

  PERFORM public.lock_rbac_orgs(OLD.org_id);

  IF NOT public.has_effective_active_org_super_admin(OLD.org_id, OLD.user_id) THEN
    DELETE FROM public.orgs
    WHERE orgs.id = OLD.org_id;
    RETURN OLD;
  END IF;

  -- Self-departure deletes nested bindings under a trusted trigger path. Require
  -- a durable successor before that nested cleanup can bypass row-level guards.
  IF public.is_effective_active_org_super_admin_user(OLD.org_id, OLD.user_id) AND NOT public.has_effective_non_expiring_org_super_admin_after_removal(
    OLD.org_id,
    NULL,
    NULL,
    NULL,
    NULL,
    OLD.user_id
  ) THEN
    RAISE EXCEPTION 'CANNOT_REMOVE_LAST_EFFECTIVE_SUPER_ADMIN'
      USING HINT = 'At least one non-expiring effective organization super admin must remain.';
  END IF;

  PERFORM public.transfer_org_owned_apikeys_from_user(OLD.user_id, OLD.org_id);

  DELETE FROM public.group_members
  USING public.groups
  WHERE group_members.group_id = groups.id
    AND groups.org_id = OLD.org_id
    AND group_members.user_id = OLD.user_id;

  DELETE FROM public.channel_permission_overrides AS overrides
  USING public.channels AS channels
  WHERE overrides.channel_id = channels.id
    AND channels.owner_org = OLD.org_id
    AND (
      (
        overrides.principal_type = public.rbac_principal_user()
        AND overrides.principal_id = OLD.user_id
      )
      OR (
        overrides.principal_type = public.rbac_principal_apikey()
        AND EXISTS (
          SELECT 1
          FROM public.apikeys
          WHERE apikeys.rbac_id = overrides.principal_id
            AND apikeys.user_id = OLD.user_id
            AND apikeys.owner_org_id IS NULL
        )
      )
    );

  DELETE FROM public.role_bindings
  WHERE role_bindings.principal_type = public.rbac_principal_user()
    AND role_bindings.principal_id = OLD.user_id
    AND role_bindings.org_id = OLD.org_id;

  DELETE FROM public.role_bindings AS bindings
  USING public.apikeys
  WHERE bindings.principal_type = public.rbac_principal_apikey()
    AND bindings.principal_id = apikeys.rbac_id
    AND apikeys.user_id = OLD.user_id
    AND apikeys.owner_org_id IS NULL
    AND bindings.org_id = OLD.org_id;

  DELETE FROM public.org_users
  WHERE org_users.user_id = OLD.user_id
    AND org_users.org_id = OLD.org_id
    AND (org_users.app_id IS NOT NULL OR org_users.channel_id IS NOT NULL);

  RETURN OLD;
END;
$$;

-- Account deletion request: personal keys are removed right away (existing
-- behavior). Shared keys stay until the purge (delete_accounts_marked_for_deletion),
-- which moves them to a successor, so a super admin added during the 30-day
-- window can still inherit them. user_id grants nothing in the meantime.
CREATE OR REPLACE FUNCTION public.delete_user()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  user_id_fn uuid;
  user_email text;
  old_record_json jsonb;
  last_sign_in_at_ts timestamptz;
  did_schedule integer;
BEGIN
  SELECT "auth"."uid"() INTO user_id_fn;
  IF user_id_fn IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT "email", "last_sign_in_at"
  INTO user_email, last_sign_in_at_ts
  FROM "auth"."users"
  WHERE "id" = user_id_fn;

  -- Require proof of email ownership from the custom email OTP flow rather than
  -- relying on Supabase auth email_confirmed_at, which may be auto-populated.
  IF NOT "public"."is_recent_email_otp_verified"(user_id_fn) THEN
    RAISE EXCEPTION 'email_not_verified' USING ERRCODE = 'P0003';
  END IF;

  IF last_sign_in_at_ts IS NULL OR last_sign_in_at_ts < NOW() - INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'reauth_required' USING ERRCODE = 'P0001';
  END IF;

  SELECT row_to_json(u)::jsonb INTO old_record_json
  FROM (
    SELECT *
    FROM "public"."users"
    WHERE id = user_id_fn
  ) AS u;

  IF old_record_json IS NULL THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO "public"."to_delete_accounts" (
    "account_id",
    "removal_date",
    "removed_data"
  ) VALUES
  (
    user_id_fn,
    NOW() + INTERVAL '30 days',
    "jsonb_build_object"('email', user_email, 'apikeys', COALESCE((SELECT "jsonb_agg"("to_jsonb"(a.*)) FROM "public"."apikeys" a WHERE a."user_id" = user_id_fn AND a."owner_org_id" IS NULL), '[]'::jsonb))
  )
  ON CONFLICT ("account_id") DO NOTHING
  RETURNING 1 INTO did_schedule;

  IF did_schedule IS NULL THEN
    RETURN;
  END IF;

  PERFORM "pgmq"."send"(
    'on_user_delete'::text,
    "jsonb_build_object"(
      'payload', "jsonb_build_object"(
        'old_record', old_record_json,
        'table', 'users',
        'type', 'DELETE'
      ),
      'function_name', 'on_user_delete'
    )
  );

  DELETE FROM "public"."apikeys"
  WHERE "public"."apikeys"."user_id" = user_id_fn
    AND "public"."apikeys"."owner_org_id" IS NULL;
END;
$$;

-- Final account purge: move shared keys before the owner's bindings and
-- personal key bindings are cleaned up.
CREATE OR REPLACE FUNCTION public.delete_accounts_marked_for_deletion()
RETURNS TABLE (deleted_count integer, deleted_user_ids uuid [])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  account_record record;
  org_record record;
  deleted_users uuid[] := ARRAY[]::uuid[];
  total_deleted integer := 0;
  replacement_owner_id uuid;
BEGIN
  FOR account_record IN
    SELECT account_id, removal_date, removed_data
    FROM public.to_delete_accounts
    WHERE removal_date < pg_catalog.now()
  LOOP
    BEGIN
      PERFORM public.transfer_org_owned_apikeys_from_user(account_record.account_id);

      FOR org_record IN
        WITH user_orgs AS (
          SELECT bindings.org_id
          FROM public.role_bindings AS bindings
          WHERE bindings.principal_type = public.rbac_principal_user()
            AND bindings.principal_id = account_record.account_id
            AND bindings.scope_type = public.rbac_scope_org()
            AND bindings.org_id IS NOT NULL
            AND (bindings.expires_at IS NULL OR bindings.expires_at > pg_catalog.now())

          UNION

          SELECT groups.org_id
          FROM public.group_members AS members
          INNER JOIN public.groups AS groups
            ON groups.id = members.group_id
          INNER JOIN public.role_bindings AS bindings
            ON bindings.principal_type = public.rbac_principal_group()
            AND bindings.principal_id = groups.id
            AND bindings.org_id = groups.org_id
            AND bindings.scope_type = public.rbac_scope_org()
          WHERE members.user_id = account_record.account_id
            AND (bindings.expires_at IS NULL OR bindings.expires_at > pg_catalog.now())
        )
        SELECT DISTINCT org_id
        FROM user_orgs
        ORDER BY org_id
      LOOP
        PERFORM public.lock_rbac_orgs(org_record.org_id);

        IF public.is_effective_active_org_super_admin_user(org_record.org_id, account_record.account_id)
          AND NOT public.has_effective_non_expiring_org_super_admin_after_removal(
            org_record.org_id,
            NULL,
            NULL,
            NULL,
            NULL,
            account_record.account_id
          )
        THEN
          -- Preserve the audit migration's tombstone and webhook suppression
          -- behavior while deleting an organization with no durable successor.
          PERFORM pg_catalog.set_config('capgo.deleting_org_id', org_record.org_id::text, true);
          DELETE FROM public.deploy_history WHERE owner_org = org_record.org_id;
          DELETE FROM public.channel_devices WHERE owner_org = org_record.org_id;
          DELETE FROM public.channels WHERE owner_org = org_record.org_id;
          DELETE FROM public.app_versions WHERE owner_org = org_record.org_id;
          DELETE FROM public.apps WHERE owner_org = org_record.org_id;
          DELETE FROM public.orgs WHERE id = org_record.org_id;
          PERFORM pg_catalog.set_config('capgo.deleting_org_id', '', true);
          CONTINUE;
        END IF;

        SELECT candidates.user_id
        INTO replacement_owner_id
        FROM (
          SELECT bindings.principal_id AS user_id, bindings.granted_at
          FROM public.role_bindings AS bindings
          INNER JOIN public.roles AS roles
            ON roles.id = bindings.role_id
            AND roles.scope_type = bindings.scope_type
          WHERE bindings.org_id = org_record.org_id
            AND bindings.principal_type = public.rbac_principal_user()
            AND bindings.principal_id <> account_record.account_id
            AND bindings.scope_type = public.rbac_scope_org()
            AND bindings.expires_at IS NULL
            AND roles.name = public.rbac_role_org_super_admin()

          UNION

          SELECT members.user_id, bindings.granted_at
          FROM public.role_bindings AS bindings
          INNER JOIN public.roles AS roles
            ON roles.id = bindings.role_id
            AND roles.scope_type = bindings.scope_type
          INNER JOIN public.groups AS groups
            ON groups.id = bindings.principal_id
            AND groups.org_id = bindings.org_id
          INNER JOIN public.group_members AS members
            ON members.group_id = groups.id
          WHERE bindings.org_id = org_record.org_id
            AND bindings.principal_type = public.rbac_principal_group()
            AND bindings.scope_type = public.rbac_scope_org()
            AND bindings.expires_at IS NULL
            AND roles.name = public.rbac_role_org_super_admin()
            AND members.user_id <> account_record.account_id
        ) AS candidates
        ORDER BY candidates.granted_at ASC, candidates.user_id ASC
        LIMIT 1;

        IF replacement_owner_id IS NOT NULL THEN
          UPDATE public.apps
          SET user_id = replacement_owner_id, updated_at = pg_catalog.now()
          WHERE user_id = account_record.account_id AND owner_org = org_record.org_id;

          UPDATE public.app_versions
          SET user_id = replacement_owner_id, updated_at = pg_catalog.now()
          WHERE user_id = account_record.account_id AND owner_org = org_record.org_id;

          UPDATE public.channels
          SET created_by = replacement_owner_id, updated_at = pg_catalog.now()
          WHERE created_by = account_record.account_id AND owner_org = org_record.org_id;

          UPDATE public.deploy_history
          SET created_by = replacement_owner_id, updated_at = pg_catalog.now()
          WHERE created_by = account_record.account_id AND owner_org = org_record.org_id;

          UPDATE public.orgs
          SET created_by = replacement_owner_id, updated_at = pg_catalog.now()
          WHERE id = org_record.org_id AND created_by = account_record.account_id;
        ELSE
          RAISE WARNING 'No durable org_super_admin found to transfer ownership in org % for user %',
            org_record.org_id, account_record.account_id;
        END IF;

      DELETE FROM public.channel_permission_overrides AS overrides
      WHERE (
        overrides.principal_type = public.rbac_principal_user()
        AND overrides.principal_id = account_record.account_id
      ) OR (
        overrides.principal_type = public.rbac_principal_apikey()
        AND EXISTS (
          SELECT 1
          FROM public.apikeys
          WHERE apikeys.rbac_id = overrides.principal_id
            AND apikeys.user_id = account_record.account_id
        )
      );
      END LOOP;

      DELETE FROM public.role_bindings
      WHERE principal_type = public.rbac_principal_user()
        AND principal_id = account_record.account_id;

      DELETE FROM public.role_bindings AS bindings
      USING public.apikeys
      WHERE bindings.principal_type = public.rbac_principal_apikey()
        AND bindings.principal_id = apikeys.rbac_id
        AND apikeys.user_id = account_record.account_id;

      DELETE FROM public.group_members WHERE user_id = account_record.account_id;
      DELETE FROM public.org_users WHERE user_id = account_record.account_id;
      DELETE FROM public.users WHERE id = account_record.account_id;
      DELETE FROM auth.users WHERE id = account_record.account_id;
      DELETE FROM public.to_delete_accounts WHERE account_id = account_record.account_id;

      deleted_users := pg_catalog.array_append(deleted_users, account_record.account_id);
      total_deleted := total_deleted + 1;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE WARNING 'Failed to delete account %: %', account_record.account_id, SQLERRM;
    END;
  END LOOP;

  deleted_count := total_deleted;
  deleted_user_ids := deleted_users;
  RETURN NEXT;
END;
$$;

-- Audit shared API keys in their owner org: key create/edit/regenerate/
-- transfer/delete (secrets stripped) and their role binding changes. Personal
-- keys have no owner org and stay out of org audit logs.
CREATE OR REPLACE FUNCTION public.audit_log_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old_record jsonb;
  v_new_record jsonb;
  v_changed_fields text[];
  v_org_id uuid;
  v_record_id text;
  v_user_id uuid;
  v_key text;
  v_api_key_text text;
  v_api_key public.apikeys%ROWTYPE;
  v_actor_type text := 'system';
  v_actor_user_id uuid;
  v_actor_user_email text;
  v_actor_apikey_id bigint;
  v_actor_apikey_name text;
  v_stats_refresh_fields constant text[] := ARRAY['stats_refresh_requested_at', 'stats_updated_at', 'updated_at'];
  v_background_counter_fields constant text[] := ARRAY['channel_device_count', 'manifest_bundle_count', 'updated_at'];
  v_onboarding_progress_fields constant text[] := ARRAY['onboarding', 'updated_at'];
  v_fat_app_version_fields constant text[] := ARRAY['manifest', 'native_packages'];
  v_apikey_secret_fields constant text[] := ARRAY['key', 'key_hash'];
  v_audit_actor_apikey_id bigint;
  v_shared_apikey public.apikeys%ROWTYPE;
  v_binding_role_name text;
BEGIN
  -- Shared API key bindings are the only role_bindings rows that are audited.
  IF TG_TABLE_NAME = 'role_bindings' THEN
    SELECT *
    INTO v_shared_apikey
    FROM public.apikeys
    WHERE apikeys.rbac_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.principal_id ELSE NEW.principal_id END
      AND apikeys.owner_org_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;

    IF v_shared_apikey.id IS NULL THEN
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END IF;

    SELECT roles.name
    INTO v_binding_role_name
    FROM public.roles
    WHERE roles.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.role_id ELSE NEW.role_id END;
  END IF;

  SELECT auth.uid() INTO v_actor_user_id;

  IF v_actor_user_id IS NOT NULL THEN
    v_actor_type := 'user';
  ELSE
    SELECT public.get_apikey_header() INTO v_api_key_text;

    IF v_api_key_text IS NOT NULL THEN
      SELECT *
      INTO v_api_key
      FROM public.find_apikey_by_value(v_api_key_text)
      LIMIT 1;

      IF v_api_key.id IS NOT NULL
        AND NOT public.is_apikey_expired(v_api_key.expires_at)
        AND (
          public.is_allowed_capgkey(v_api_key_text, '{upload}'::text[])
          OR public.is_allowed_capgkey(v_api_key_text, '{write}'::text[])
          OR public.is_allowed_capgkey(v_api_key_text, '{all}'::text[])
        ) THEN
        v_actor_type := 'apikey';
        v_actor_user_id := v_api_key.user_id;
        v_actor_apikey_id := v_api_key.id;
        v_actor_apikey_name := v_api_key.name;
      END IF;
    END IF;
  END IF;

  -- Backend writes run as a service connection; they pass the authenticated
  -- caller through transaction-local settings.
  IF v_actor_type = 'system' THEN
    v_audit_actor_apikey_id := NULLIF(pg_catalog.current_setting('capgo.audit_actor_apikey_id', true), '')::bigint;
    IF v_audit_actor_apikey_id IS NOT NULL THEN
      SELECT *
      INTO v_api_key
      FROM public.apikeys
      WHERE apikeys.id = v_audit_actor_apikey_id;

      IF v_api_key.id IS NOT NULL THEN
        v_actor_type := 'apikey';
        v_actor_user_id := v_api_key.user_id;
        v_actor_apikey_id := v_api_key.id;
        v_actor_apikey_name := v_api_key.name;
      END IF;
    ELSE
      v_actor_user_id := NULLIF(pg_catalog.current_setting('capgo.audit_actor_user_id', true), '')::uuid;
      IF v_actor_user_id IS NOT NULL THEN
        v_actor_type := 'user';
      END IF;
    END IF;
  END IF;

  IF v_actor_user_id IS NOT NULL THEN
    SELECT users.email
    INTO v_actor_user_email
    FROM public.users AS users
    WHERE users.id = v_actor_user_id;
  END IF;

  v_user_id := v_actor_user_id;

  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'app_versions' THEN
    v_old_record := pg_catalog.to_jsonb(OLD);
    v_new_record := pg_catalog.to_jsonb(NEW);
    IF (
      v_old_record
        - 'manifest'
        - 'updated_at'
        - 'manifest_count'
        - 'storage_provider'
        - 'r2_path'
    ) IS NOT DISTINCT FROM (
      v_new_record
        - 'manifest'
        - 'updated_at'
        - 'manifest_count'
        - 'storage_provider'
        - 'r2_path'
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_old_record := pg_catalog.to_jsonb(OLD);
    v_new_record := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    v_old_record := NULL;
    v_new_record := pg_catalog.to_jsonb(NEW);
  ELSE
    v_old_record := pg_catalog.to_jsonb(OLD);
    v_new_record := pg_catalog.to_jsonb(NEW);

    FOR v_key IN SELECT pg_catalog.jsonb_object_keys(v_new_record)
    LOOP
      IF v_old_record->v_key IS DISTINCT FROM v_new_record->v_key THEN
        v_changed_fields := pg_catalog.array_append(v_changed_fields, v_key);
      END IF;
    END LOOP;

    IF v_changed_fields IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(v_changed_fields) AS changed_field(field_name)
        WHERE changed_field.field_name IS DISTINCT FROM 'updated_at'
      ) THEN
      RETURN NEW;
    END IF;

    IF TG_TABLE_NAME = ANY(ARRAY['apps', 'orgs'])
      AND v_changed_fields && ARRAY['stats_refresh_requested_at', 'stats_updated_at']
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(v_changed_fields) AS changed_field(field_name)
        WHERE changed_field.field_name <> ALL(v_stats_refresh_fields)
      ) THEN
      RETURN NEW;
    END IF;

    IF v_actor_type = 'system'
      AND TG_TABLE_NAME = 'apps'
      AND v_changed_fields && ARRAY['channel_device_count', 'manifest_bundle_count']
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(v_changed_fields) AS changed_field(field_name)
        WHERE changed_field.field_name <> ALL(v_background_counter_fields)
      ) THEN
      RETURN NEW;
    END IF;

    IF TG_TABLE_NAME = 'apps'
      AND v_changed_fields && ARRAY['onboarding']
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(v_changed_fields) AS changed_field(field_name)
        WHERE changed_field.field_name <> ALL(v_onboarding_progress_fields)
      ) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Never store API key secrets, even hashed, in audit logs or webhooks.
  IF TG_TABLE_NAME = 'apikeys' THEN
    IF v_old_record IS NOT NULL THEN
      v_old_record := v_old_record - v_apikey_secret_fields;
    END IF;
    IF v_new_record IS NOT NULL THEN
      v_new_record := v_new_record - v_apikey_secret_fields;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'role_bindings' THEN
    IF v_old_record IS NOT NULL THEN
      v_old_record := v_old_record || pg_catalog.jsonb_build_object('role_name', v_binding_role_name, 'apikey_id', v_shared_apikey.id, 'apikey_name', v_shared_apikey.name);
    END IF;
    IF v_new_record IS NOT NULL THEN
      v_new_record := v_new_record || pg_catalog.jsonb_build_object('role_name', v_binding_role_name, 'apikey_id', v_shared_apikey.id, 'apikey_name', v_shared_apikey.name);
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'app_versions' THEN
    IF v_old_record IS NOT NULL THEN
      v_old_record := v_old_record - v_fat_app_version_fields;
    END IF;
    IF v_new_record IS NOT NULL THEN
      v_new_record := v_new_record - v_fat_app_version_fields;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    CASE TG_TABLE_NAME
      WHEN 'orgs' THEN
        v_org_id := OLD.id;
        v_record_id := OLD.id::text;
      WHEN 'apps' THEN
        v_org_id := OLD.owner_org;
        v_record_id := OLD.app_id::text;
      WHEN 'channels' THEN
        v_org_id := OLD.owner_org;
        v_record_id := OLD.id::text;
      WHEN 'app_versions' THEN
        v_org_id := OLD.owner_org;
        v_record_id := OLD.id::text;
      WHEN 'org_users' THEN
        v_org_id := OLD.org_id;
        v_record_id := OLD.id::text;
      WHEN 'apikeys' THEN
        v_org_id := OLD.owner_org_id;
        v_record_id := OLD.id::text;
      WHEN 'role_bindings' THEN
        v_org_id := v_shared_apikey.owner_org_id;
        v_record_id := v_shared_apikey.id::text;
      ELSE
        v_org_id := NULL;
        v_record_id := NULL;
    END CASE;
  ELSE
    CASE TG_TABLE_NAME
      WHEN 'orgs' THEN
        v_org_id := NEW.id;
        v_record_id := NEW.id::text;
      WHEN 'apps' THEN
        v_org_id := NEW.owner_org;
        v_record_id := NEW.app_id::text;
      WHEN 'channels' THEN
        v_org_id := NEW.owner_org;
        v_record_id := NEW.id::text;
      WHEN 'app_versions' THEN
        v_org_id := NEW.owner_org;
        v_record_id := NEW.id::text;
      WHEN 'org_users' THEN
        v_org_id := NEW.org_id;
        v_record_id := NEW.id::text;
      WHEN 'apikeys' THEN
        v_org_id := NEW.owner_org_id;
        v_record_id := NEW.id::text;
      WHEN 'role_bindings' THEN
        v_org_id := v_shared_apikey.owner_org_id;
        v_record_id := v_shared_apikey.id::text;
      ELSE
        v_org_id := NULL;
        v_record_id := NULL;
    END CASE;
  END IF;

  IF v_org_id IS NOT NULL THEN
    INSERT INTO public.audit_logs (
      table_name,
      record_id,
      operation,
      user_id,
      org_id,
      old_record,
      new_record,
      changed_fields,
      actor_type,
      actor_user_id,
      actor_user_email,
      actor_apikey_id,
      actor_apikey_name
    ) VALUES (
      TG_TABLE_NAME,
      v_record_id,
      TG_OP,
      v_user_id,
      v_org_id,
      v_old_record,
      v_new_record,
      v_changed_fields,
      v_actor_type,
      v_actor_user_id,
      v_actor_user_email,
      v_actor_apikey_id,
      v_actor_apikey_name
    );
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

-- Only shared keys produce audit rows (owner_org_id). The WHEN clauses keep
-- personal-key and non-apikey writes off the audit path entirely.
CREATE TRIGGER audit_apikeys_trigger
AFTER INSERT OR UPDATE ON public.apikeys
FOR EACH ROW
WHEN (NEW.owner_org_id IS NOT NULL)
EXECUTE FUNCTION public.audit_log_trigger();

CREATE TRIGGER audit_apikeys_delete_trigger
AFTER DELETE ON public.apikeys
FOR EACH ROW
WHEN (OLD.owner_org_id IS NOT NULL)
EXECUTE FUNCTION public.audit_log_trigger();

CREATE TRIGGER audit_apikey_role_bindings_trigger
AFTER INSERT OR UPDATE ON public.role_bindings
FOR EACH ROW
WHEN (NEW.principal_type = 'apikey')
EXECUTE FUNCTION public.audit_log_trigger();

CREATE TRIGGER audit_apikey_role_bindings_delete_trigger
AFTER DELETE ON public.role_bindings
FOR EACH ROW
WHEN (OLD.principal_type = 'apikey')
EXECUTE FUNCTION public.audit_log_trigger();

COMMENT ON TABLE public.audit_logs IS
'Audit log for tracking changes to orgs, apps, channels, app_versions, org_users, shared (org-owned) apikeys, and their role_bindings';
