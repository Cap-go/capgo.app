import { describe, expect, it } from 'vitest'
import { ensureCapacitorCorePlaceholder, toNativePackageMap } from '../supabase/functions/_backend/utils/app_native_packages.ts'
import { matchAppPackagesToAdvisories } from '../supabase/functions/_backend/utils/security_advisory_matching.ts'
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
    expect(items.filter(item => item.package === '@capacitor/core')).toHaveLength(2)
    expect(items.filter(item => item.package === '@capgo/cli')).toHaveLength(1)
    expect(items.every(item => item.status === 'unknown')).toBe(true)
  })

  it('keeps packages when version is not a string', () => {
    const map = filterInScopePackages(toNativePackageMap([
      { name: '@capgo/cli', version: 2 as unknown as string },
    ]))
    expect(map.get('@capgo/cli')).toBe('')
  })

  it('does not overwrite a known version with a later blank duplicate', () => {
    const map = toNativePackageMap([
      { name: '@capacitor/core', version: '6.1.0' },
      { name: '@capacitor/core', version: '' },
    ])
    expect(map.get('@capacitor/core')).toBe('6.1.0')
  })
})

describe('ensureCapacitorCorePlaceholder', () => {
  it('adds blank core when ios is reported without core', () => {
    const map = filterInScopePackages(toNativePackageMap([
      { name: '@capacitor/ios', version: '6.2.0' },
    ]))
    ensureCapacitorCorePlaceholder(map)
    expect(map.get('@capacitor/core')).toBe('')
    const items = matchAppPackagesToAdvisories(map, fixtureAdvisoryFeedForTests().advisories)
    expect(items.some(item => item.package === '@capacitor/core' && item.status === 'unknown')).toBe(true)
  })

  it('adds blank core when android is reported without core', () => {
    const map = filterInScopePackages(toNativePackageMap([
      { name: '@capacitor/android', version: '6.2.0' },
    ]))
    ensureCapacitorCorePlaceholder(map)
    expect(map.get('@capacitor/core')).toBe('')
    const items = matchAppPackagesToAdvisories(map, fixtureAdvisoryFeedForTests().advisories)
    expect(items.some(item => item.package === '@capacitor/core' && item.status === 'unknown')).toBe(true)
  })
})
