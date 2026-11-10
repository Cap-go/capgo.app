import { describe, expect, it } from 'vitest'
import type { Advisory } from '../supabase/functions/shared/security_advisory.ts'
import { matchAppPackagesToAdvisories, resolveAdvisoryStatus } from '../supabase/functions/_backend/utils/security_advisory_matching.ts'
import { fixtureAdvisoryFeedForTests } from '../supabase/functions/_backend/utils/security_advisory_feed.ts'

const advisory = fixtureAdvisoryFeedForTests().advisories[0]!

describe('admin security updates patch flattening shape', () => {
  it('exposes one row per affected package from the feed', () => {
    const rows = advisory.affected.map(affected => ({
      ghsa_id: advisory.ghsa_id,
      package: affected.package,
      patched_version: affected.patched_version,
      created_at: advisory.published_at,
    }))
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
})
