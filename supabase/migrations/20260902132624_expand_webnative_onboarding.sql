ALTER TABLE "public"."orgs"
DROP CONSTRAINT "orgs_onboarding_valid";

ALTER TABLE "public"."orgs"
ADD CONSTRAINT "orgs_onboarding_valid" CHECK (
  ("jsonb_typeof"("onboarding") = 'object'::"text")
  AND (
    (NOT ("onboarding" ? 'intent'::"text"))
    OR (
      ("onboarding" ->> 'intent'::"text")
      = ANY (ARRAY['unknown'::"text", 'ota'::"text", 'builder'::"text", 'both'::"text", 'exploring'::"text", 'publish'::"text"])
    )
  )
);

COMMENT ON COLUMN "public"."orgs"."onboarding" IS 'Onboarding answers (extensible JSONB). Currently: {"intent": unknown|ota|builder|both|exploring|publish}. Used for segmentation and to tailor the org experience.';

ALTER TABLE "public"."users"
DROP CONSTRAINT "users_onboarding_valid";

ALTER TABLE "public"."users"
ADD CONSTRAINT "users_onboarding_valid" CHECK (
  ("jsonb_typeof"("onboarding") = 'object'::"text")
  AND ("octet_length"(("onboarding")::"text") <= 65536)
  AND (
    (NOT ("onboarding" ? 'status'::"text"))
    OR (
      ("jsonb_typeof"(("onboarding" -> 'status'::"text")) = 'string'::"text")
      AND (("onboarding" ->> 'status'::"text") = ANY (ARRAY['in_progress'::"text", 'completed'::"text", 'abandoned'::"text"]))
    )
  )
  AND (
    (NOT ("onboarding" ? 'step'::"text"))
    OR (
      ("jsonb_typeof"(("onboarding" -> 'step'::"text")) = 'string'::"text")
      AND (("onboarding" ->> 'step'::"text") = ANY (ARRAY['intent'::"text", 'details'::"text", 'organization'::"text", 'choice'::"text", 'install'::"text", 'setup'::"text"]))
    )
  )
  AND (
    (NOT ("onboarding" ? 'flow'::"text"))
    OR (
      ("jsonb_typeof"(("onboarding" -> 'flow'::"text")) = 'string'::"text")
      AND (("onboarding" ->> 'flow'::"text") = ANY (ARRAY['pre_org'::"text", 'existing_org'::"text"]))
    )
  )
  AND (
    (NOT ("onboarding" ? 'development_environment'::"text"))
    OR (
      ("jsonb_typeof"(("onboarding" -> 'development_environment'::"text")) = 'string'::"text")
      AND (("onboarding" ->> 'development_environment'::"text") = ANY (ARRAY['hosted_builder'::"text", 'local_project'::"text", 'exploring'::"text"]))
    )
  )
  AND (
    (NOT ("onboarding" ? 'intent'::"text"))
    OR (
      ("jsonb_typeof"(("onboarding" -> 'intent'::"text")) = 'string'::"text")
      AND (("onboarding" ->> 'intent'::"text") = ANY (ARRAY['ota'::"text", 'builder'::"text", 'both'::"text", 'exploring'::"text", 'publish'::"text"]))
    )
  )
) NOT VALID;

COMMENT ON COLUMN "public"."users"."onboarding" IS 'Persisted create-app onboarding wizard progress for resume and admin drop-off. Keys: status, step, flow, development_environment, intent, details_step, app_name, app_id, existing_app, existing_app_setup, store_url, imported_store_app_id, org_name, estimated_users_index, onboarding_attempt_id, last_run_id, abtests, updated_at, completed_at.';
