ALTER TABLE "public"."users"
ADD COLUMN "onboarding" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL;

COMMENT ON COLUMN "public"."users"."onboarding" IS 'Persisted create-app onboarding wizard progress for resume and admin drop-off. Keys: status, step, flow, intent, app_name, app_id, existing_app, existing_app_setup, store_url, imported_store_app_id, org_name, estimated_users_index, updated_at, completed_at.';

ALTER TABLE "public"."users"
ADD CONSTRAINT "users_onboarding_valid" CHECK (
  ("jsonb_typeof"("onboarding") = 'object'::"text")
  AND ("octet_length"(("onboarding")::"text") <= 8192)
  AND ((NOT ("onboarding" ? 'status'::"text")) OR (("jsonb_typeof"(("onboarding" -> 'status'::"text")) = 'string'::"text") AND (("onboarding" ->> 'status'::"text") = ANY (ARRAY['in_progress'::"text", 'completed'::"text", 'abandoned'::"text"]))))
  AND ((NOT ("onboarding" ? 'step'::"text")) OR (("jsonb_typeof"(("onboarding" -> 'step'::"text")) = 'string'::"text") AND (("onboarding" ->> 'step'::"text") = ANY (ARRAY['intent'::"text", 'details'::"text", 'organization'::"text", 'choice'::"text", 'install'::"text", 'setup'::"text"]))))
  AND ((NOT ("onboarding" ? 'flow'::"text")) OR (("jsonb_typeof"(("onboarding" -> 'flow'::"text")) = 'string'::"text") AND (("onboarding" ->> 'flow'::"text") = ANY (ARRAY['pre_org'::"text", 'existing_org'::"text"]))))
  AND ((NOT ("onboarding" ? 'intent'::"text")) OR (("jsonb_typeof"(("onboarding" -> 'intent'::"text")) = 'string'::"text") AND (("onboarding" ->> 'intent'::"text") = ANY (ARRAY['ota'::"text", 'builder'::"text", 'both'::"text", 'exploring'::"text"]))))
) NOT VALID;

CREATE INDEX "users_onboarding_in_progress_step_idx"
  ON "public"."users" USING "btree" (("onboarding" ->> 'step'::"text"))
  WHERE (("onboarding" ->> 'status'::"text") = 'in_progress'::"text");
