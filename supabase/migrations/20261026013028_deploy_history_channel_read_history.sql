-- Honor channel.read_history on direct deploy_history reads.
--
-- The deploy_history SELECT policy only checks org membership, so an explicit
-- channel.read_history deny override on a channel did not hide that channel's
-- history from PostgREST reads. Keep the membership predicate unchanged and
-- AND it with an exclusion of the caller's denied channels, resolved once per
-- statement (same approach as the channels / channel_devices SELECT policies).
--
-- The helper lives in rbac_internal, which PostgREST does not expose, so it is
-- callable from RLS but not as a public RPC.

CREATE OR REPLACE FUNCTION "rbac_internal"."deploy_history_denied_channel_ids"() RETURNS bigint[]
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  SELECT public.rbac_denied_channel_ids_for_permission(public.rbac_perm_channel_read_history())
$$;

ALTER FUNCTION "rbac_internal"."deploy_history_denied_channel_ids"() OWNER TO "postgres";

COMMENT ON FUNCTION "rbac_internal"."deploy_history_denied_channel_ids"() IS 'RLS helper: channel IDs where the request principal has an explicit channel.read_history deny override. Used by the deploy_history SELECT policy. Lives in rbac_internal (not PostgREST-exposed).';

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
