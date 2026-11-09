import { describe, expect, it } from 'vitest'
import { matchAppPackagesToAdvisories } from '../supabase/functions/_backend/utils/security_advisory_matching.ts'
import { toNativePackageMap } from '../supabase/functions/_backend/utils/app_native_packages.ts'
import { filterInScopePackages } from '../supabase/functions/_backend/utils/security_advisory_packages.ts'
import { fixtureAdvisoryFeedForTests } from '../supabase/functions/_backend/utils/security_advisory_feed.ts'

describe('toNativePackageMap', () => {
  it('keeps packages with blank versions for unknown matching', () => {
    const map = filterInScopePackages(toNativePackageMap([
      { name: '@capgo/cli', version: '' },
      { name: '@capacitor/core', version: '   ' },
    ]))
    expect(map.get('@capgo/cli')).toBe('')
    expect(map.get('@capacitor/core')).toBe('')
    const items = matchAppPackagesToAdvisories(map, fixtureAdvisoryFeedForTests().advisories)
    expect(items.every(item => item.status === 'unknown')).toBe(true)
  })

  it('keeps packages when version is not a string', () => {
    const map = filterInScopePackages(toNativePackageMap([
      { name: '@capgo/cli', version: 2 as unknown as string },
    ]))
    expect(map.get('@capgo/cli')).toBe('')
  })
})
