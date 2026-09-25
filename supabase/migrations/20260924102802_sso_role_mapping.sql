-- Optional SAML attribute -> org role / group mapping, re-evaluated by
-- /private/sso/provision-user on every SSO login. NULL keeps the historical
-- behavior (new members get org_member, existing roles are left untouched).
-- Shape (validated by /private/sso/providers, the only writer):
--   {
--     "attribute": "<SAML attribute name>",
--     "rules": [{ "value": "<attribute value>", "role": "<org role>" | null, "group_id": "<uuid>" | null }],
--     "default_role": "<org role>" | null   -- null = no access when nothing matches
--   }
ALTER TABLE "public"."sso_providers"
ADD COLUMN "role_mapping" "jsonb";

ALTER TABLE "public"."sso_providers"
ADD CONSTRAINT "sso_providers_role_mapping_object_check"
CHECK ("role_mapping" IS NULL OR "jsonb_typeof"("role_mapping") = 'object');

COMMENT ON COLUMN "public"."sso_providers"."role_mapping" IS 'Optional SAML attribute to org role/group mapping applied on every SSO login. NULL = legacy behavior (org_member for new members).';
