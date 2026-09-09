ALTER TABLE "public"."orgs"
DROP CONSTRAINT IF EXISTS "orgs_onboarding_valid";

ALTER TABLE "public"."orgs"
ADD CONSTRAINT "orgs_onboarding_valid" CHECK (
  ("jsonb_typeof"("onboarding") = 'object'::"text")
  AND (
    (NOT ("onboarding" ? 'intent'::"text"))
    OR (
      ("jsonb_typeof"(("onboarding" -> 'intent'::"text")) = 'string'::"text")
      AND (("onboarding" ->> 'intent'::"text") = ANY (ARRAY['unknown'::"text", 'ota'::"text", 'builder'::"text", 'both'::"text", 'exploring'::"text", 'publish'::"text"]))
    )
  )
  AND (
    (NOT ("onboarding" ? 'development_environment'::"text"))
    OR (
      ("jsonb_typeof"(("onboarding" -> 'development_environment'::"text")) = 'string'::"text")
      AND (("onboarding" ->> 'development_environment'::"text") = ANY (ARRAY['hosted_builder'::"text", 'ai_assistant'::"text", 'hand_coded'::"text", 'other'::"text", 'local_project'::"text", 'exploring'::"text", 'skipped'::"text"]))
    )
  )
) NOT VALID;
