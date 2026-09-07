import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const webnativeOnboardingMigration = readFileSync(
  new URL('../supabase/migrations/20260907163000_expand_webnative_onboarding.sql', import.meta.url),
  'utf8',
)

describe('webnative onboarding schema migration', () => {
  it.concurrent('drops the old users constraint before backfilling historical keys', () => {
    const orgsDrop = webnativeOnboardingMigration.indexOf('DROP CONSTRAINT IF EXISTS "orgs_onboarding_valid"')
    const orgsIntentBackfill = webnativeOnboardingMigration.indexOf(`SET "onboarding" = "onboarding" - 'intent'`, orgsDrop)
    const orgsEnvironmentBackfill = webnativeOnboardingMigration.indexOf(`SET "onboarding" = "onboarding" - 'development_environment'`, orgsIntentBackfill)
    const orgsAdd = webnativeOnboardingMigration.indexOf('ADD CONSTRAINT "orgs_onboarding_valid"')
    const usersDrop = webnativeOnboardingMigration.indexOf('DROP CONSTRAINT IF EXISTS "users_onboarding_valid"')
    const usersIntentBackfill = webnativeOnboardingMigration.indexOf(`SET "onboarding" = "onboarding" - 'intent'`, usersDrop)
    const usersEnvironmentBackfill = webnativeOnboardingMigration.indexOf(`SET "onboarding" = "onboarding" - 'development_environment'`, usersIntentBackfill)
    const usersAdd = webnativeOnboardingMigration.indexOf('ADD CONSTRAINT "users_onboarding_valid"')

    expect(orgsDrop).toBeGreaterThan(-1)
    expect(orgsIntentBackfill).toBeGreaterThan(orgsDrop)
    expect(orgsEnvironmentBackfill).toBeGreaterThan(orgsIntentBackfill)
    expect(orgsAdd).toBeGreaterThan(orgsEnvironmentBackfill)
    expect(usersDrop).toBeGreaterThan(orgsAdd)
    expect(usersIntentBackfill).toBeGreaterThan(usersDrop)
    expect(usersEnvironmentBackfill).toBeGreaterThan(usersIntentBackfill)
    expect(usersAdd).toBeGreaterThan(usersEnvironmentBackfill)
    expect(webnativeOnboardingMigration).toContain(`<> ALL (ARRAY['ota'::"text", 'builder'::"text", 'both'::"text", 'exploring'::"text", 'publish'::"text"])`)
    expect(webnativeOnboardingMigration).toContain(`<> ALL (ARRAY['unknown'::"text", 'ota'::"text", 'builder'::"text", 'both'::"text", 'exploring'::"text", 'publish'::"text"])`)
  })
})
