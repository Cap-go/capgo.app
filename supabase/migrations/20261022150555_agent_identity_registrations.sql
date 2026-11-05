-- auth.md agent registration (https://capgo.app/auth.md, service_auth flow).
-- An agent registers with the user's email, the user signs in to the console, picks organizations and
-- types the six-digit user_code, and the agent polls the token endpoint for a regular Capgo API key.
-- No secret is stored in clear: claim_token, claim_attempt_token and user_code are SHA-256 hashed, and
-- the minted API key is sealed to a per-registration ECDH key whose private half is encrypted with the
-- claim_token, which only the agent holds.

CREATE TABLE "public"."agent_identity_registrations" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "registration_type" text NOT NULL DEFAULT 'service_auth',
  "login_hint" text NOT NULL,
  "claim_token_hash" text NOT NULL,
  "public_key" text NOT NULL,
  "encrypted_private_key" text NOT NULL,
  "claim_attempt_token_hash" text,
  "user_code_hash" text,
  "user_code_expires_at" timestamp with time zone,
  "user_code_attempts" integer NOT NULL DEFAULT 0,
  "code_verified_by" uuid,
  "status" text NOT NULL DEFAULT 'pending',
  "user_id" uuid,
  "apikey_id" bigint,
  "encrypted_token" text,
  "ip_hash" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  "last_polled_at" timestamp with time zone,
  "approved_at" timestamp with time zone,
  "exchanged_at" timestamp with time zone,
  CONSTRAINT "agent_identity_registrations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_identity_registrations_type_check" CHECK ("registration_type" IN ('service_auth')),
  CONSTRAINT "agent_identity_registrations_status_check" CHECK ("status" IN ('pending', 'approved', 'denied', 'exchanged')),
  CONSTRAINT "agent_identity_registrations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  CONSTRAINT "agent_identity_registrations_code_verified_by_fkey" FOREIGN KEY ("code_verified_by") REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  CONSTRAINT "agent_identity_registrations_apikey_id_fkey" FOREIGN KEY ("apikey_id") REFERENCES "public"."apikeys"("id") ON DELETE SET NULL
);
ALTER TABLE "public"."agent_identity_registrations" OWNER TO "postgres";
COMMENT ON TABLE "public"."agent_identity_registrations" IS 'auth.md service_auth agent registrations and their claim ceremony. Tokens and codes are stored as SHA-256 hashes; the minted API key is sealed so only the agent holding the claim_token can open it. Service role only.';

CREATE UNIQUE INDEX "agent_identity_registrations_claim_token_hash_idx" ON "public"."agent_identity_registrations" ("claim_token_hash");
CREATE UNIQUE INDEX "agent_identity_registrations_claim_attempt_token_hash_idx" ON "public"."agent_identity_registrations" ("claim_attempt_token_hash") WHERE "claim_attempt_token_hash" IS NOT NULL;
CREATE INDEX "agent_identity_registrations_ip_hash_idx" ON "public"."agent_identity_registrations" ("ip_hash", "created_at") WHERE "ip_hash" IS NOT NULL;
CREATE INDEX "agent_identity_registrations_expires_at_idx" ON "public"."agent_identity_registrations" ("expires_at") WHERE "status" <> 'exchanged';
CREATE INDEX "agent_identity_registrations_apikey_id_idx" ON "public"."agent_identity_registrations" ("apikey_id") WHERE "apikey_id" IS NOT NULL;
CREATE INDEX "agent_identity_registrations_user_id_idx" ON "public"."agent_identity_registrations" ("user_id") WHERE "user_id" IS NOT NULL;
CREATE INDEX "agent_identity_registrations_code_verified_by_idx" ON "public"."agent_identity_registrations" ("code_verified_by") WHERE "code_verified_by" IS NOT NULL;

ALTER TABLE "public"."agent_identity_registrations" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "public"."agent_identity_registrations" FROM PUBLIC;
REVOKE ALL ON TABLE "public"."agent_identity_registrations" FROM "anon";
REVOKE ALL ON TABLE "public"."agent_identity_registrations" FROM "authenticated";
GRANT ALL ON TABLE "public"."agent_identity_registrations" TO "service_role";

CREATE POLICY "Deny all direct access"
ON "public"."agent_identity_registrations"
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (false)
WITH CHECK (false);
