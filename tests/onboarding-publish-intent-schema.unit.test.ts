import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const publishIntentOnboardingMigration = readFileSync(
  new URL('../supabase/migrations/20260907163000_expand_webnative_onboarding.sql', import.meta.url),
  'utf8',
)

describe('publish intent onboarding schema migration', () => {
  it.concurrent('backfills invalid historical keys before the new constraints', () => {
    const orgsIntentUpdate = publishIntentOnboardingMigration.indexOf('UPDATE "public"."orgs"\nSET "onboarding" = "onboarding" - \'intent\'')
    const orgsEnvironmentUpdate = publishIntentOnboardingMigration.indexOf('UPDATE "public"."orgs"\nSET "onboarding" = "onboarding" - \'development_environment\'')
    const usersIntentUpdate = publishIntentOnboardingMigration.indexOf('UPDATE "public"."users"\nSET "onboarding" = "onboarding" - \'intent\'')
    const usersEnvironmentUpdate = publishIntentOnboardingMigration.indexOf('UPDATE "public"."users"\nSET "onboarding" = "onboarding" - \'development_environment\'')
    const orgsDrop = publishIntentOnboardingMigration.indexOf('DROP CONSTRAINT IF EXISTS "orgs_onboarding_valid"')
    const orgsAdd = publishIntentOnboardingMigration.indexOf('ADD CONSTRAINT "orgs_onboarding_valid"')
    const usersDrop = publishIntentOnboardingMigration.indexOf('DROP CONSTRAINT IF EXISTS "users_onboarding_valid"')
    const usersAdd = publishIntentOnboardingMigration.indexOf('ADD CONSTRAINT "users_onboarding_valid"')

    expect(orgsIntentUpdate).toBeGreaterThan(-1)
    expect(orgsEnvironmentUpdate).toBeGreaterThan(orgsIntentUpdate)
    expect(usersIntentUpdate).toBeGreaterThan(orgsEnvironmentUpdate)
    expect(usersEnvironmentUpdate).toBeGreaterThan(usersIntentUpdate)
    expect(orgsDrop).toBeGreaterThan(usersEnvironmentUpdate)
    expect(orgsAdd).toBeGreaterThan(orgsDrop)
    expect(usersDrop).toBeGreaterThan(orgsAdd)
    expect(usersAdd).toBeGreaterThan(usersDrop)

    const orgsIntentBackfillSql = publishIntentOnboardingMigration.slice(orgsIntentUpdate, orgsEnvironmentUpdate)
    const orgsEnvironmentBackfillSql = publishIntentOnboardingMigration.slice(orgsEnvironmentUpdate, usersIntentUpdate)
    const usersIntentBackfillSql = publishIntentOnboardingMigration.slice(usersIntentUpdate, usersEnvironmentUpdate)
    const usersEnvironmentBackfillSql = publishIntentOnboardingMigration.slice(usersEnvironmentUpdate, orgsDrop)

    expect(orgsIntentBackfillSql).toContain('UPDATE "public"."orgs"')
    expect(orgsEnvironmentBackfillSql).toContain('UPDATE "public"."orgs"')
    expect(usersIntentBackfillSql).toContain('UPDATE "public"."users"')
    expect(usersEnvironmentBackfillSql).toContain('UPDATE "public"."users"')

    const orgsIntentAllowed = `ARRAY['unknown'::"text", 'ota'::"text", 'builder'::"text", 'both'::"text", 'exploring'::"text", 'publish'::"text"]`
    const usersIntentAllowed = `ARRAY['ota'::"text", 'builder'::"text", 'both'::"text", 'exploring'::"text", 'publish'::"text"]`
    const developmentEnvironmentAllowed = `ARRAY['hosted_builder'::"text", 'ai_assistant'::"text", 'hand_coded'::"text", 'other'::"text", 'local_project'::"text", 'exploring'::"text", 'skipped'::"text"]`

    for (const sql of [orgsIntentBackfillSql, usersIntentBackfillSql]) {
      expect(sql).toContain(`("onboarding" ? 'intent'::"text")`)
      expect(sql).toContain(`("jsonb_typeof"(("onboarding" -> 'intent'::"text")) IS DISTINCT FROM 'string'::"text")`)
      expect(sql).toContain(`("onboarding" ->> 'intent'::"text") <> ALL`)
    }
    expect(orgsIntentBackfillSql).toContain(orgsIntentAllowed)
    expect(usersIntentBackfillSql).toContain(usersIntentAllowed)

    for (const sql of [orgsEnvironmentBackfillSql, usersEnvironmentBackfillSql]) {
      expect(sql).toContain(`("onboarding" ? 'development_environment'::"text")`)
      expect(sql).toContain(`("jsonb_typeof"(("onboarding" -> 'development_environment'::"text")) IS DISTINCT FROM 'string'::"text")`)
      expect(sql).toContain(`("onboarding" ->> 'development_environment'::"text") <> ALL (${developmentEnvironmentAllowed})`)
    }

    // Check the allowed values inside the new CHECK constraints, not the
    // backfill predicates that repeat them.
    const orgsConstraint = publishIntentOnboardingMigration.slice(orgsAdd, usersDrop)
    const usersConstraint = publishIntentOnboardingMigration.slice(usersAdd)
    expect(orgsConstraint).toContain(`= ANY (${orgsIntentAllowed})`)
    expect(usersConstraint).toContain(`("onboarding" ->> 'intent'::"text") = ANY (${usersIntentAllowed})`)
    for (const constraint of [orgsConstraint, usersConstraint])
      expect(constraint).toContain(`("onboarding" ->> 'development_environment'::"text") = ANY (${developmentEnvironmentAllowed})`)
  })
})
