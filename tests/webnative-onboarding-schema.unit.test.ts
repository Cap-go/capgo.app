import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const webnativeOnboardingMigration = readFileSync(
  new URL('../supabase/migrations/20260907163000_expand_webnative_onboarding.sql', import.meta.url),
  'utf8',
)

describe('WebNative onboarding schema migration', () => {
  it.concurrent('backfills invalid historical keys before the new CHECKs', () => {
    const usersDrop = webnativeOnboardingMigration.indexOf('DROP CONSTRAINT IF EXISTS "users_onboarding_valid"')
    const usersIntentBackfill = webnativeOnboardingMigration.indexOf(`SET "onboarding" = "onboarding" - 'intent'`, usersDrop)
    const usersAdd = webnativeOnboardingMigration.indexOf('ADD CONSTRAINT "users_onboarding_valid"')
    const orgsDrop = webnativeOnboardingMigration.indexOf('DROP CONSTRAINT IF EXISTS "orgs_onboarding_valid"')
    const orgsIntentBackfill = webnativeOnboardingMigration.indexOf(`SET "onboarding" = "onboarding" - 'intent'`, orgsDrop)
    const orgsAdd = webnativeOnboardingMigration.indexOf('ADD CONSTRAINT "orgs_onboarding_valid"')

    expect(orgsDrop).toBeGreaterThan(-1)
    expect(orgsIntentBackfill).toBeGreaterThan(orgsDrop)
    expect(orgsAdd).toBeGreaterThan(orgsIntentBackfill)
    expect(usersDrop).toBeGreaterThan(orgsAdd)
    expect(usersIntentBackfill).toBeGreaterThan(usersDrop)
    expect(usersAdd).toBeGreaterThan(usersIntentBackfill)
    expect(webnativeOnboardingMigration).toContain(`<> ALL (ARRAY['ota'::"text", 'builder'::"text", 'both'::"text", 'exploring'::"text", 'publish'::"text"])`)
    expect(webnativeOnboardingMigration).toContain(`<> ALL (ARRAY['unknown'::"text", 'ota'::"text", 'builder'::"text", 'both'::"text", 'exploring'::"text", 'publish'::"text"])`)
  })
})
