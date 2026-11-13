import { describe, expect, it } from 'vitest'
import type { Advisory } from '../supabase/functions/shared/security_advisory.ts'
import { flattenPatches, summarizeAdoptionForAdvisory } from '../supabase/functions/_backend/utils/security_advisory_admin_tracking.ts'
import { matchAppPackagesToAdvisories, resolveAdvisoryStatus } from '../supabase/functions/_backend/utils/security_advisory_matching.ts'
import { fixtureAdvisoryFeedForTests } from '../supabase/functions/_backend/utils/security_advisory_feed.ts'

const advisory = fixtureAdvisoryFeedForTests().advisories[0]!

describe('admin security updates patch flattening shape', () => {
  it('exposes one row per affected package from the feed', () => {
    const rows = flattenPatches(fixtureAdvisoryFeedForTests().advisories)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]?.ghsa_id).toBe(advisory.ghsa_id)
  })
})

describe('admin security updates adoption summary', () => {
  it('classifies demo app packages against the fixture advisory', () => {
    const packages = new Map<string, string>([
      ['@capacitor/core', '6.1.0'],
      ['@capgo/cli', '1.9.0'],
    ])
    const matches = matchAppPackagesToAdvisories(packages, [advisory as Advisory])
    const hasAffected = matches.some(match => resolveAdvisoryStatus(match.current_version, match.affected) === 'affected')
    expect(hasAffected).toBe(true)
  })

  it('aggregates per-app worst status with affected over unknown over patched', () => {
    const perApp = new Map<string, Map<string, string>>([
      ['com.patched.app', new Map([['@capacitor/core', '7.2.1']])],
      ['com.vulnerable.app', new Map([['@capacitor/core', '6.1.0']])],
      ['com.unrelated.app', new Map([['lodash', '4.0.0']])],
    ])
    const summary = summarizeAdoptionForAdvisory(advisory as Advisory, perApp)
    expect(summary.apps_relevant).toBe(2)
    expect(summary.apps_vulnerable).toBe(1)
    expect(summary.apps_patched).toBe(1)
    expect(summary.apps_unknown).toBe(0)
  })
})
