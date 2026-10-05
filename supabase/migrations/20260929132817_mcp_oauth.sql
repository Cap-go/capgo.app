-- OAuth 2.1 authorization server state for the hosted Capgo MCP server (https://api.capgo.app/mcp).
-- Access tokens are regular Capgo API keys minted by the user on the console consent page, so
-- RBAC, org API key policies and revocation all reuse the existing API key system. These tables
-- only hold dynamically registered clients and short-lived authorization requests / codes.

CREATE TABLE "public"."mcp_oauth_clients" (
  "client_id" text NOT NULL,
  "client_name" text NOT NULL,
  "client_uri" text,
  "logo_uri" text,
  "redirect_uris" text[] NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_used_at" timestamp with time zone,
  "ip_hash" text,
  CONSTRAINT "mcp_oauth_clients_pkey" PRIMARY KEY ("client_id"),
  CONSTRAINT "mcp_oauth_clients_redirect_uris_not_empty" CHECK (cardinality("redirect_uris") BETWEEN 1 AND 20)
);
ALTER TABLE "public"."mcp_oauth_clients" OWNER TO "postgres";
COMMENT ON TABLE "public"."mcp_oauth_clients" IS 'RFC 7591 dynamically registered public clients of the hosted MCP OAuth server. Service role only.';

-- ip_hash = SHA-256 of the registering IP, used only for the per-IP registration limit.
CREATE INDEX "mcp_oauth_clients_ip_hash_idx" ON "public"."mcp_oauth_clients" ("ip_hash", "created_at") WHERE "ip_hash" IS NOT NULL;
CREATE INDEX "mcp_oauth_clients_unused_idx" ON "public"."mcp_oauth_clients" ("created_at") WHERE "last_used_at" IS NULL;

-- One row per /authorize call. client_id is not a foreign key because clients can also be
-- identified by an OAuth Client ID Metadata Document URL instead of a registered client.
CREATE TABLE "public"."mcp_oauth_requests" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "client_id" text NOT NULL,
  "client_name" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "state" text,
  "scope" text,
  "resource" text,
  "code_challenge" text NOT NULL,
  "issuer" text NOT NULL,
  "ip_hash" text,
  "status" text NOT NULL DEFAULT 'pending',
  "user_id" uuid,
  "apikey_id" bigint,
  "code_hash" text,
  "encrypted_token" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  "code_expires_at" timestamp with time zone,
  "exchanged_at" timestamp with time zone,
  CONSTRAINT "mcp_oauth_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mcp_oauth_requests_status_check" CHECK ("status" IN ('pending', 'approved', 'denied', 'exchanged')),
  CONSTRAINT "mcp_oauth_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  CONSTRAINT "mcp_oauth_requests_apikey_id_fkey" FOREIGN KEY ("apikey_id") REFERENCES "public"."apikeys"("id") ON DELETE SET NULL
);
ALTER TABLE "public"."mcp_oauth_requests" OWNER TO "postgres";
COMMENT ON TABLE "public"."mcp_oauth_requests" IS 'Hosted MCP OAuth authorization requests and single-use codes. The code is never stored: only its SHA-256 hash, and the minted API key is AES-GCM encrypted with a key derived from the code. Service role only.';

CREATE UNIQUE INDEX "mcp_oauth_requests_code_hash_idx" ON "public"."mcp_oauth_requests" ("code_hash") WHERE "code_hash" IS NOT NULL;
CREATE INDEX "mcp_oauth_requests_ip_hash_idx" ON "public"."mcp_oauth_requests" ("ip_hash", "created_at") WHERE "ip_hash" IS NOT NULL;
CREATE INDEX "mcp_oauth_requests_expires_at_idx" ON "public"."mcp_oauth_requests" ("expires_at") WHERE "status" <> 'exchanged';
CREATE INDEX "mcp_oauth_requests_apikey_id_idx" ON "public"."mcp_oauth_requests" ("apikey_id") WHERE "apikey_id" IS NOT NULL;
CREATE INDEX "mcp_oauth_requests_user_id_idx" ON "public"."mcp_oauth_requests" ("user_id") WHERE "user_id" IS NOT NULL;

ALTER TABLE "public"."mcp_oauth_clients" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "public"."mcp_oauth_clients" FROM PUBLIC;
REVOKE ALL ON TABLE "public"."mcp_oauth_clients" FROM "anon";
REVOKE ALL ON TABLE "public"."mcp_oauth_clients" FROM "authenticated";
GRANT ALL ON TABLE "public"."mcp_oauth_clients" TO "service_role";

ALTER TABLE "public"."mcp_oauth_requests" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "public"."mcp_oauth_requests" FROM PUBLIC;
REVOKE ALL ON TABLE "public"."mcp_oauth_requests" FROM "anon";
REVOKE ALL ON TABLE "public"."mcp_oauth_requests" FROM "authenticated";
GRANT ALL ON TABLE "public"."mcp_oauth_requests" TO "service_role";
