-- Dedicated native builders: org-scoped request + provisioning state.
-- Actual runner routing lives in the external builder service; Capgo stores
-- preference, fallback policy, and customer-facing status.

ALTER TABLE "public"."build_requests"
  ADD COLUMN IF NOT EXISTS "builder_pool" text;

COMMENT ON COLUMN "public"."build_requests"."builder_pool" IS
  'Preferred builder pool at request time (dedicated or shared). May differ from the pool that actually ran the job when shared fallback is enabled. Null for legacy rows.';

ALTER TABLE "public"."build_requests"
  DROP CONSTRAINT IF EXISTS "build_requests_builder_pool_check";

-- NOT VALID: avoid a blocking ACCESS EXCLUSIVE full scan of build_requests on apply.
-- New/updated rows are still checked; validate later in a maintenance window if desired.
ALTER TABLE "public"."build_requests"
  ADD CONSTRAINT "build_requests_builder_pool_check"
  CHECK (("builder_pool" IS NULL OR "builder_pool" = ANY (ARRAY['dedicated'::text, 'shared'::text])))
  NOT VALID;

CREATE INDEX IF NOT EXISTS "idx_build_requests_org_pool_status"
  ON "public"."build_requests" USING "btree" ("owner_org", "builder_pool", "status");

CREATE TABLE IF NOT EXISTS "public"."dedicated_builders" (
  "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
  "org_id" "uuid" NOT NULL,
  "status" "text" DEFAULT 'requested'::"text" NOT NULL,
  "requested_by" "uuid",
  "use_case" "text",
  "monthly_builds_estimate" integer,
  "platforms" "text"[] DEFAULT ARRAY[]::"text"[] NOT NULL,
  "allow_shared_fallback" boolean DEFAULT true NOT NULL,
  "pool_id" "text",
  "worker_name" "text",
  "worker_status" "text" DEFAULT 'unknown'::"text" NOT NULL,
  "worker_current_job_id" "text",
  "worker_last_seen_at" timestamp with time zone,
  "activated_at" timestamp with time zone,
  "suspended_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
  CONSTRAINT "dedicated_builders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dedicated_builders_org_id_key" UNIQUE ("org_id"),
  CONSTRAINT "dedicated_builders_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE,
  CONSTRAINT "dedicated_builders_requested_by_fkey"
    FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL,
  CONSTRAINT "dedicated_builders_status_check" CHECK (
    ("status" = ANY (ARRAY[
      'requested'::"text",
      'provisioning'::"text",
      'active'::"text",
      'suspended'::"text",
      'cancelled'::"text"
    ]))
  ),
  CONSTRAINT "dedicated_builders_worker_status_check" CHECK (
    ("worker_status" = ANY (ARRAY[
      'unknown'::"text",
      'idle'::"text",
      'busy'::"text",
      'offline'::"text"
    ]))
  ),
  CONSTRAINT "dedicated_builders_monthly_builds_estimate_check" CHECK (
    ("monthly_builds_estimate" IS NULL OR "monthly_builds_estimate" >= 0)
  ),
  CONSTRAINT "dedicated_builders_use_case_length_check" CHECK (
    ("use_case" IS NULL OR "char_length"("use_case") <= 2000)
  ),
  CONSTRAINT "dedicated_builders_pool_id_length_check" CHECK (
    ("pool_id" IS NULL OR "char_length"("pool_id") <= 128)
  ),
  CONSTRAINT "dedicated_builders_worker_name_length_check" CHECK (
    ("worker_name" IS NULL OR "char_length"("worker_name") <= 128)
  ),
  CONSTRAINT "dedicated_builders_platforms_check" CHECK (
    ("platforms" <@ ARRAY['ios'::text, 'android'::text])
  )
);

ALTER TABLE "public"."dedicated_builders" OWNER TO "postgres";

COMMENT ON TABLE "public"."dedicated_builders" IS
  'Org-scoped dedicated native builder requests and provisioning state. Mutations go through the private API (service_role).';

COMMENT ON COLUMN "public"."dedicated_builders"."status" IS
  'requested → provisioning → active (or suspended/cancelled). Capgo ops advances status after provisioning the worker.';

COMMENT ON COLUMN "public"."dedicated_builders"."allow_shared_fallback" IS
  'When true, builds may use the shared Capgo pool if the dedicated worker is busy or offline.';

COMMENT ON COLUMN "public"."dedicated_builders"."pool_id" IS
  'External builder pool identifier used when routing jobs to this org dedicated worker.';

CREATE INDEX IF NOT EXISTS "idx_dedicated_builders_status"
  ON "public"."dedicated_builders" USING "btree" ("status");

CREATE OR REPLACE TRIGGER "handle_dedicated_builders_updated_at"
  BEFORE UPDATE ON "public"."dedicated_builders"
  FOR EACH ROW
  EXECUTE FUNCTION "extensions"."moddatetime"('updated_at');

ALTER TABLE "public"."dedicated_builders" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service_role full access to dedicated_builders"
ON "public"."dedicated_builders"
TO "service_role"
USING (true)
WITH CHECK (true);

-- Clients must use the private API; deny PostgREST direct access.
CREATE POLICY "deny_direct_select_on_dedicated_builders"
ON "public"."dedicated_builders"
AS RESTRICTIVE
FOR SELECT
TO "anon", "authenticated"
USING (false);

CREATE POLICY "deny_direct_insert_on_dedicated_builders"
ON "public"."dedicated_builders"
AS RESTRICTIVE
FOR INSERT
TO "anon", "authenticated"
WITH CHECK (false);

CREATE POLICY "deny_direct_update_on_dedicated_builders"
ON "public"."dedicated_builders"
AS RESTRICTIVE
FOR UPDATE
TO "anon", "authenticated"
USING (false)
WITH CHECK (false);

CREATE POLICY "deny_direct_delete_on_dedicated_builders"
ON "public"."dedicated_builders"
AS RESTRICTIVE
FOR DELETE
TO "anon", "authenticated"
USING (false);

GRANT ALL ON TABLE "public"."dedicated_builders" TO "anon";
GRANT ALL ON TABLE "public"."dedicated_builders" TO "authenticated";
GRANT ALL ON TABLE "public"."dedicated_builders" TO "service_role";
