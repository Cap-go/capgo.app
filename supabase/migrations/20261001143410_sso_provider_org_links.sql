-- An SSO provider belongs to the org that verified its domain, and a domain can
-- only have one provider (Supabase Auth routes sign-in by domain). Companies
-- with several Capgo orgs behind one IdP share that provider instead: each
-- linked org gets its own role mapping, applied on every SSO login next to the
-- owner org's mapping.
--
-- A link is only created by /private/sso/providers/:id/links when the caller
-- is super admin of both orgs, which is the consent of both sides. Like
-- sso_providers, rows are only written by the backend (service role / direct
-- Postgres): clients have no access at all.
CREATE TABLE "public"."sso_provider_org_links" (
  "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
  "sso_provider_id" "uuid" NOT NULL,
  "org_id" "uuid" NOT NULL,
  -- Same shape as sso_providers.role_mapping. NULL = the link grants nothing
  -- yet: domain users are never added to a linked org without a mapping.
  "role_mapping" "jsonb",
  "linked_by" "uuid",
  "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
  CONSTRAINT "sso_provider_org_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sso_provider_org_links_provider_org_key" UNIQUE ("sso_provider_id", "org_id"),
  CONSTRAINT "sso_provider_org_links_sso_provider_id_fkey" FOREIGN KEY ("sso_provider_id") REFERENCES "public"."sso_providers"("id") ON DELETE CASCADE,
  CONSTRAINT "sso_provider_org_links_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE,
  CONSTRAINT "sso_provider_org_links_linked_by_fkey" FOREIGN KEY ("linked_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  CONSTRAINT "sso_provider_org_links_role_mapping_object_check" CHECK ("role_mapping" IS NULL OR "jsonb_typeof"("role_mapping") = 'object')
);

ALTER TABLE "public"."sso_provider_org_links" OWNER TO "postgres";

COMMENT ON TABLE "public"."sso_provider_org_links" IS 'Orgs sharing an SSO provider owned by another org (same company, same IdP). Each link carries the role mapping applied to that org on every SSO login. Written only by /private/sso/providers/:id/links.';

CREATE INDEX "sso_provider_org_links_org_id_idx" ON "public"."sso_provider_org_links" USING "btree" ("org_id");

ALTER TABLE "public"."sso_provider_org_links" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Deny all access" ON "public"."sso_provider_org_links" TO "anon", "authenticated" USING (false) WITH CHECK (false);

REVOKE ALL ON TABLE "public"."sso_provider_org_links" FROM "anon", "authenticated";
GRANT ALL ON TABLE "public"."sso_provider_org_links" TO "service_role";
