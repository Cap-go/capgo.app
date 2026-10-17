import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const publishIntentOnboardingMigration = readFileSync(
  new URL('../supabase/migrations/20260907163000_expand_webnative_onboarding.sql', import.meta.url),
  'utf8',
)

describe('publish intent onboarding schema migration', () => {
  it.concurrent('backfills invalid historical keys before the new constraints', () => {
    const orgsIntentBackfill = publishIntentOnboardingMigration.indexOf(`SET "onboarding" = "onboarding" - 'intent'`)
    const orgsEnvironmentBackfill = publishIntentOnboardingMigration.indexOf(`SET "onboarding" = "onboarding" - 'development_environment'`, orgsIntentBackfill)
    const orgsDrop = publishIntentOnboardingMigration.indexOf('DROP CONSTRAINT IF EXISTS "orgs_onboarding_valid"')
    const orgsAdd = publishIntentOnboardingMigration.indexOf('ADD CONSTRAINT "orgs_onboarding_valid"')
    const usersIntentBackfill = publishIntentOnboardingMigration.indexOf(`SET "onboarding" = "onboarding" - 'intent'`, orgsEnvironmentBackfill)
    const usersEnvironmentBackfill = publishIntentOnboardingMigration.indexOf(`SET "onboarding" = "onboarding" - 'development_environment'`, usersIntentBackfill)
    const usersDrop = publishIntentOnboardingMigration.indexOf('DROP CONSTRAINT IF EXISTS "users_onboarding_valid"')
    const usersAdd = publishIntentOnboardingMigration.indexOf('ADD CONSTRAINT "users_onboarding_valid"')

    expect(orgsIntentBackfill).toBeGreaterThan(-1)
    expect(orgsEnvironmentBackfill).toBeGreaterThan(orgsIntentBackfill)
    expect(usersIntentBackfill).toBeGreaterThan(orgsEnvironmentBackfill)
    expect(usersEnvironmentBackfill).toBeGreaterThan(usersIntentBackfill)
    expect(orgsDrop).toBeGreaterThan(usersEnvironmentBackfill)
    expect(orgsAdd).toBeGreaterThan(orgsDrop)
    expect(usersDrop).toBeGreaterThan(orgsAdd)
    expect(usersAdd).toBeGreaterThan(usersDrop)
    expect(publishIntentOnboardingMigration).toContain(`<> ALL (ARRAY['ota'::"text", 'builder'::"text", 'both'::"text", 'exploring'::"text", 'publish'::"text"])`)
    expect(publishIntentOnboardingMigration).toContain(`<> ALL (ARRAY['unknown'::"text", 'ota'::"text", 'builder'::"text", 'both'::"text", 'exploring'::"text", 'publish'::"text"])`)
  })
})
