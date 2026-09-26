-- SSO providers are only written by /private/sso/* (service role / direct
-- Postgres), which enforce the Enterprise plan, domain validation, the
-- Supabase Auth provider lifecycle and the auth.users.is_sso_user sync.
-- Direct PostgREST writes bypassed all of that: any org admin (every user owns
-- a personal org) could reserve any email domain with a pending row, and
-- client-side deletes silently left rows behind. Reads stay as they are.

DROP POLICY IF EXISTS "allow_org_admins_insert_sso_providers" ON "public"."sso_providers";
DROP POLICY IF EXISTS "allow_org_admins_update_sso_providers" ON "public"."sso_providers";
DROP POLICY IF EXISTS "allow_org_super_admins_delete_sso_providers" ON "public"."sso_providers";

CREATE POLICY "Deny client insert on sso_providers"
ON "public"."sso_providers"
AS RESTRICTIVE
FOR INSERT
TO "anon", "authenticated"
WITH CHECK (false);

CREATE POLICY "Deny client update on sso_providers"
ON "public"."sso_providers"
AS RESTRICTIVE
FOR UPDATE
TO "anon", "authenticated"
USING (false)
WITH CHECK (false);

CREATE POLICY "Deny client delete on sso_providers"
ON "public"."sso_providers"
AS RESTRICTIVE
FOR DELETE
TO "anon", "authenticated"
USING (false);

-- The Supabase Auth SAML provider is now created on activation (after DNS
-- verification), not when the row is added: keep the metadata to create it
-- with, whichever source the org admin gave.
ALTER TABLE "public"."sso_providers"
ADD COLUMN IF NOT EXISTS "metadata_xml" "text";

COMMENT ON COLUMN "public"."sso_providers"."metadata_xml" IS 'Raw IdP SAML metadata, used instead of metadata_url when the IdP metadata endpoint is not reachable. Sent to Supabase Auth on activation.';

-- ---------------------------------------------------------------------------

-- Optional SAML attribute -> org role / group mapping, re-evaluated by
-- /private/sso/provision-user on every SSO login. NULL keeps the historical
-- behavior (new members get org_member, existing roles are left untouched).
-- Shape (validated by /private/sso/providers, the only writer):
--   {
--     "rules": [{
--       "attribute": "<SAML attribute name>", "value": "<attribute value>",
--       "org_role": "<org role>" | null,
--       "apps": [{ "app_id": "<apps.id>", "role": "<app role>" }],
--       "group_id": "<uuid>" | null
--     }],
--     "default_role": "<org role>" | null   -- null = no access when nothing matches
--   }
ALTER TABLE "public"."sso_providers"
ADD COLUMN "role_mapping" "jsonb";

ALTER TABLE "public"."sso_providers"
ADD CONSTRAINT "sso_providers_role_mapping_object_check"
CHECK ("role_mapping" IS NULL OR "jsonb_typeof"("role_mapping") = 'object');

COMMENT ON COLUMN "public"."sso_providers"."role_mapping" IS 'Optional SAML attribute to org role/group mapping applied on every SSO login. NULL = legacy behavior (org_member for new members).';
