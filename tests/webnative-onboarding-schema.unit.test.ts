import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const webnativeOnboardingMigration = readFileSync(
  new URL('../supabase/migrations/20260907163000_expand_webnative_onboarding.sql', import.meta.url),
  'utf8',
)

describe('webnative onboarding schema migration', () => {
  it.concurrent('backfills invalid historical keys before the new constraints', () => {
    const orgsIntentBackfill = webnativeOnboardingMigration.indexOf(`SET "onboarding" = "onboarding" - 'intent'`)
    const orgsEnvironmentBackfill = webnativeOnboardingMigration.indexOf(`SET "onboarding" = "onboarding" - 'development_environment'`, orgsIntentBackfill)
    const orgsDrop = webnativeOnboardingMigration.indexOf('DROP CONSTRAINT IF EXISTS "orgs_onboarding_valid"')
    const orgsAdd = webnativeOnboardingMigration.indexOf('ADD CONSTRAINT "orgs_onboarding_valid"')
    const usersIntentBackfill = webnativeOnboardingMigration.indexOf(`SET "onboarding" = "onboarding" - 'intent'`, orgsAdd)
    const usersEnvironmentBackfill = webnativeOnboardingMigration.indexOf(`SET "onboarding" = "onboarding" - 'development_environment'`, usersIntentBackfill)
    const usersDrop = webnativeOnboardingMigration.indexOf('DROP CONSTRAINT IF EXISTS "users_onboarding_valid"')
    const usersAdd = webnativeOnboardingMigration.indexOf('ADD CONSTRAINT "users_onboarding_valid"')

    expect(orgsIntentBackfill).toBeGreaterThan(-1)
    expect(orgsEnvironmentBackfill).toBeGreaterThan(orgsIntentBackfill)
    expect(orgsDrop).toBeGreaterThan(orgsEnvironmentBackfill)
    expect(orgsAdd).toBeGreaterThan(orgsDrop)
    expect(usersIntentBackfill).toBeGreaterThan(orgsAdd)
    expect(usersEnvironmentBackfill).toBeGreaterThan(usersIntentBackfill)
    expect(usersDrop).toBeGreaterThan(usersEnvironmentBackfill)
    expect(usersAdd).toBeGreaterThan(usersDrop)
    expect(webnativeOnboardingMigration).toContain(`<> ALL (ARRAY['ota'::"text", 'builder'::"text", 'both'::"text", 'exploring'::"text", 'publish'::"text"])`)
    expect(webnativeOnboardingMigration).toContain(`<> ALL (ARRAY['unknown'::"text", 'ota'::"text", 'builder'::"text", 'both'::"text", 'exploring'::"text", 'publish'::"text"])`)
  })
})
