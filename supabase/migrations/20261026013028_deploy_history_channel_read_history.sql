-- Honor channel.read_history on direct deploy_history reads.
--
-- The deploy_history SELECT policy only checked org membership, so any org
-- member could read the history of every channel, even without a
-- channel.read_history grant (for example org_member with only an app_uploader
-- or app_preview binding) or with an explicit deny override on the channel.
-- Keep the membership predicate unchanged and AND it with an exclusion of the
-- channels where the caller's effective channel.read_history permission is
-- false, resolved once per statement.
--
-- Effective permission matches rbac_check_permission_direct with a concrete
-- channel: the app-level result is evaluated once per app, and a channel can
-- only differ from it when it has an override for the permission or a
-- channel-scoped role binding, so only those channels are evaluated
-- individually.
--
-- The helper lives in rbac_internal, which PostgREST does not expose, so it is
-- callable from RLS but not as a public RPC.

CREATE OR REPLACE FUNCTION "rbac_internal"."deploy_history_denied_channel_ids"() RETURNS bigint[]
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_permission text := public.rbac_perm_channel_read_history();
  v_denied bigint[];
BEGIN
  -- The deploy_history SELECT policy only applies to authenticated users.
  IF v_user_id IS NULL THEN
    RETURN '{}'::bigint[];
  END IF;

  WITH app_level AS MATERIALIZED (
    SELECT
      a.app_id,
      public.rbac_check_permission_direct(
        v_permission,
        v_user_id,
        a.owner_org,
        a.app_id,
        NULL::bigint,
        NULL::text
      ) AS allowed
    FROM public.apps a
    WHERE a.owner_org = ANY(public.current_user_member_org_ids())
  )
  SELECT COALESCE(array_agg(ch.id), '{}'::bigint[])
  INTO v_denied
  FROM app_level
  INNER JOIN public.channels ch ON ch.app_id = app_level.app_id
  WHERE CASE
    WHEN EXISTS (
      SELECT 1
      FROM public.channel_permission_overrides o
      WHERE o.channel_id = ch.id
        AND o.permission_key = v_permission
    ) OR EXISTS (
      SELECT 1
      FROM public.role_bindings rb
      WHERE rb.scope_type = public.rbac_scope_channel()
        AND rb.channel_id = ch.rbac_id
    ) THEN NOT public.rbac_check_permission_direct(
      v_permission,
      v_user_id,
      ch.owner_org,
      ch.app_id,
      ch.id,
      NULL::text
    )
    ELSE NOT app_level.allowed
  END;

  RETURN v_denied;
END;
$$;

ALTER FUNCTION "rbac_internal"."deploy_history_denied_channel_ids"() OWNER TO "postgres";

COMMENT ON FUNCTION "rbac_internal"."deploy_history_denied_channel_ids"() IS 'RLS helper: channel IDs in the caller''s member orgs where the caller''s effective channel.read_history permission is false (app-level grant plus channel overrides and channel-scoped bindings). Used by the deploy_history SELECT policy. Lives in rbac_internal (not PostgREST-exposed).';

REVOKE ALL ON FUNCTION "rbac_internal"."deploy_history_denied_channel_ids"() FROM PUBLIC;
GRANT ALL ON FUNCTION "rbac_internal"."deploy_history_denied_channel_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "rbac_internal"."deploy_history_denied_channel_ids"() TO "service_role";

DROP POLICY IF EXISTS "Allow users to view deploy history for their org" ON "public"."deploy_history";

CREATE POLICY "Allow users to view deploy history for their org" ON "public"."deploy_history"
    FOR SELECT
    TO "authenticated"
    USING (
        ("owner_org" = ANY (COALESCE((SELECT "public"."current_user_member_org_ids"() AS "current_user_member_org_ids"), '{}'::"uuid"[])))
        AND NOT ("channel_id" = ANY (COALESCE((SELECT "rbac_internal"."deploy_history_denied_channel_ids"() AS "deploy_history_denied_channel_ids"), '{}'::bigint[])))
    );
