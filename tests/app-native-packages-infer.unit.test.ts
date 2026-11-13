import { describe, expect, it } from 'vitest'
import {
  buildReportedPackageMap,
  ensureCapacitorCorePlaceholder,
  reportedPackageMapFromCatalogRow,
  toNativePackageMap,
} from '../supabase/functions/_backend/utils/app_native_packages.ts'
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

describe('reportedPackageMapFromCatalogRow', () => {
  it('matches loadAppReportedPackages when production native_packages are null', () => {
    const production = { native_packages: null, cli_version: '1.0.0' as string | null }
    const latest = {
      native_packages: [{ name: '@capacitor/core', version: '6.1.0' }],
      cli_version: '2.0.0' as string | null,
    }
    const perApp = buildReportedPackageMap(production, latest)
    const fromCatalog = reportedPackageMapFromCatalogRow({
      app_id: 'com.test.app',
      has_production_channel: true,
      production_native_packages: null,
      production_cli_version: '1.0.0',
      has_latest_upload: true,
      latest_native_packages: latest.native_packages,
      latest_cli_version: '2.0.0',
    })
    expect(fromCatalog).toEqual(perApp)
    expect(fromCatalog.has('@capacitor/core')).toBe(false)
    expect(fromCatalog.get('@capgo/cli')).toBe('2.0.0')
  })

  it('uses latest upload when no production channel exists', () => {
    const latest = {
      native_packages: [{ name: '@capacitor/core', version: '6.1.0' }],
      cli_version: '1.9.0' as string | null,
    }
    const perApp = buildReportedPackageMap(latest, latest)
    const fromCatalog = reportedPackageMapFromCatalogRow({
      app_id: 'com.test.app',
      has_production_channel: false,
      production_native_packages: null,
      production_cli_version: null,
      has_latest_upload: true,
      latest_native_packages: latest.native_packages,
      latest_cli_version: '1.9.0',
    })
    expect(fromCatalog).toEqual(perApp)
    expect(fromCatalog.get('@capacitor/core')).toBe('6.1.0')
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
