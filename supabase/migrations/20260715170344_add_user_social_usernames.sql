ALTER TABLE "public"."users"
ADD COLUMN "discord_username" character varying(32),
ADD COLUMN "github_username" character varying(39);

COMMENT ON COLUMN "public"."users"."discord_username" IS 'Optional Discord username supplied by the user for future experience enrichment.';
COMMENT ON COLUMN "public"."users"."github_username" IS 'Optional GitHub username supplied by the user for future experience enrichment.';

-- Finish the RBAC-only baseline cleanup so database tests and new deployments do
-- not retain a trigger body that references the removed org_users.user_right column.
CREATE OR REPLACE FUNCTION "public"."generate_org_user_on_org_create"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  org_super_admin_role_id uuid;
BEGIN
  SELECT "id"
  INTO org_super_admin_role_id
  FROM "public"."roles"
  WHERE "name" = "public"."rbac_role_org_super_admin"()
  LIMIT 1;

  IF org_super_admin_role_id IS NOT NULL THEN
    INSERT INTO "public"."role_bindings" (
      "principal_type",
      "principal_id",
      "role_id",
      "scope_type",
      "org_id",
      "granted_by",
      "granted_at",
      "reason",
      "is_direct"
    ) VALUES (
      "public"."rbac_principal_user"(),
      NEW."created_by",
      org_super_admin_role_id,
      "public"."rbac_scope_org"(),
      NEW."id",
      NEW."created_by",
      pg_catalog.now(),
      'Auto-granted on org creation',
      true
    )
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION "public"."generate_org_user_on_org_create"() IS 'Creates the initial org super-admin role binding when an organization is created.';

REVOKE ALL ON FUNCTION "public"."get_org_apikeys"(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION "public"."get_org_apikeys"(uuid) TO authenticated;

-- Preserve API-key and authenticated compatibility RPC access after the baseline hardening pass.
GRANT EXECUTE ON FUNCTION "public"."get_org_perm_for_apikey_v2"(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."get_org_members"(uuid) TO anon;
GRANT EXECUTE ON FUNCTION "public"."get_org_members_rbac"(uuid) TO anon;
GRANT EXECUTE ON FUNCTION "public"."check_org_members_password_policy"(uuid) TO anon;
GRANT EXECUTE ON FUNCTION "public"."update_org_invite_role_rbac"(uuid, uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION "public"."update_tmp_invite_role_rbac"(uuid, text, text) TO anon;
GRANT EXECUTE ON FUNCTION "public"."check_org_members_2fa_enabled"(uuid) TO anon;

REVOKE ALL ON FUNCTION "public"."assert_effective_super_admin_binding_removal"(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."assert_effective_super_admin_binding_removal"(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION "public"."prevent_role_binding_priority_escalation"() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."prevent_role_binding_priority_escalation"() TO service_role;

REVOKE ALL ON FUNCTION "public"."get_org_members"(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION "public"."get_org_members"(uuid, uuid) TO service_role;
