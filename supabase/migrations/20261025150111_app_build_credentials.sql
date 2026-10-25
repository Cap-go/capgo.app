-- Per-app, per-platform native build credentials stored server-side so builds
-- (CLI or hosted MCP) can reference them without secrets passing through a chat.
--
-- The secret material lives only in "ciphertext": an AES-256-GCM envelope
-- produced by the backend (utils/build_credentials_crypto.ts) with the
-- BUILD_CREDENTIALS_ENCRYPTION_KEY runtime secret and AAD bound to
-- app_id + platform. "key_version" is the fingerprint of the key that sealed
-- the row, so rotation (BUILD_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS) can open
-- older rows. "summary" holds non-secret facts only (which keys are set,
-- iOS distribution, team id, ...).
--
-- Access is service-role only through the /build/credentials routes, which
-- authorize with RBAC (app.build_native to read the summary,
-- app.update_settings to write/delete). anon/authenticated never see a row.
-- owner_org is informational (refreshed on every write); authorization is
-- always derived from the app's current owner via RBAC.

CREATE TABLE "public"."app_build_credentials" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "app_id" character varying NOT NULL,
  "owner_org" uuid NOT NULL,
  "platform" text NOT NULL,
  "ciphertext" text NOT NULL,
  "key_version" text NOT NULL,
  "summary" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_by" uuid,
  "updated_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "app_build_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "app_build_credentials_platform_check" CHECK ("platform" IN ('ios', 'android')),
  CONSTRAINT "app_build_credentials_app_platform_key" UNIQUE ("app_id", "platform"),
  CONSTRAINT "app_build_credentials_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("app_id") ON DELETE CASCADE,
  CONSTRAINT "app_build_credentials_owner_org_fkey" FOREIGN KEY ("owner_org") REFERENCES "public"."orgs"("id") ON DELETE CASCADE,
  CONSTRAINT "app_build_credentials_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  CONSTRAINT "app_build_credentials_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL
);
ALTER TABLE "public"."app_build_credentials" OWNER TO "postgres";
COMMENT ON TABLE "public"."app_build_credentials" IS 'Encrypted native build signing credentials per app and platform. ciphertext is an AES-256-GCM envelope sealed by the backend; summary is non-secret metadata. Service role only.';
COMMENT ON COLUMN "public"."app_build_credentials"."ciphertext" IS 'AES-256-GCM envelope (v1:<iv>:<ciphertext>) of the credentials JSON, AAD bound to app_id and platform. Never decrypted in SQL.';
COMMENT ON COLUMN "public"."app_build_credentials"."key_version" IS 'Fingerprint of the BUILD_CREDENTIALS_ENCRYPTION_KEY that sealed ciphertext, used for key rotation.';
COMMENT ON COLUMN "public"."app_build_credentials"."summary" IS 'Non-secret facts only: credential key names, iOS distribution, team id, upload method. Never secret values.';

-- (app_id, platform) unique index already covers app_id lookups.
CREATE INDEX "app_build_credentials_owner_org_idx" ON "public"."app_build_credentials" ("owner_org");
CREATE INDEX "app_build_credentials_created_by_idx" ON "public"."app_build_credentials" ("created_by") WHERE "created_by" IS NOT NULL;
CREATE INDEX "app_build_credentials_updated_by_idx" ON "public"."app_build_credentials" ("updated_by") WHERE "updated_by" IS NOT NULL;

ALTER TABLE "public"."app_build_credentials" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "public"."app_build_credentials" FROM PUBLIC;
REVOKE ALL ON TABLE "public"."app_build_credentials" FROM "anon";
REVOKE ALL ON TABLE "public"."app_build_credentials" FROM "authenticated";
GRANT ALL ON TABLE "public"."app_build_credentials" TO "service_role";

CREATE POLICY "Deny all direct access"
ON "public"."app_build_credentials"
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (false)
WITH CHECK (false);
