import { describe, expect, it } from 'vitest'
import { countsAsBundleFailure as countsAsBundleFailurePlugin, isLegacyDownloadFailPlugin as isLegacyPlugin } from '../supabase/functions/_backend/plugin_runtime/utils/legacyDownloadFail.ts'
import { countsAsBundleFailure, isLegacyDownloadFailPlugin, legacyDownloadFailKey, legacyDownloadFailPluginSqlCF, subtractLegacyDownloadFails, sumLegacyDownloadFails } from '../supabase/functions/_backend/utils/legacyDownloadFail.ts'

const LEGACY = ['0.9.1', '4.42.0', '5.10.3', '6.0.0', '6.52.9', '7.17.0', '7.52.1', '8.0.0', '8.9.12', '8.51.16', '8.52.0']
const FIXED = ['6.53.0', '7.53.0', '8.53.0', '8.53.1-beta.2', '8.60.0', '8.100.0', '9.0.0', '10.1.0']
const UNKNOWN = ['', 'not-a-version', null, undefined]

// Analytics Engine LIKE: % is any run of characters, _ exactly one.
function like(value: string, pattern: string) {
  const regex = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')
  return new RegExp(`^${regex}$`).test(value)
}

function matchesSqlPredicate(version: string) {
  const patterns = [...legacyDownloadFailPluginSqlCF('blob7').matchAll(/LIKE '([^']+)'/g)].map(match => match[1])
  return patterns.some(pattern => like(version, pattern))
}

describe('legacy download_fail plugins', () => {
  it('flags plugins that report a failed update check as download_fail', () => {
    for (const version of LEGACY)
      expect(isLegacyDownloadFailPlugin(version), version).toBe(true)
    for (const version of [...FIXED, ...UNKNOWN])
      expect(isLegacyDownloadFailPlugin(version), String(version)).toBe(false)
  })

  it('keeps the plugin runtime copy identical', () => {
    for (const version of [...LEGACY, ...FIXED, ...UNKNOWN]) {
      expect(isLegacyPlugin(version)).toBe(isLegacyDownloadFailPlugin(version))
      expect(countsAsBundleFailurePlugin('download_fail', version)).toBe(countsAsBundleFailure('download_fail', version))
    }
  })

  it('only drops download_fail of legacy plugins', () => {
    expect(countsAsBundleFailure('download_fail', '8.51.16')).toBe(false)
    expect(countsAsBundleFailure('download_fail', '8.53.0')).toBe(true)
    expect(countsAsBundleFailure('update_fail', '8.51.16')).toBe(true)
    expect(countsAsBundleFailure('unzip_fail', '7.0.0')).toBe(true)
  })

  it('matches the same plugin versions in Analytics Engine SQL', () => {
    const versions = [...LEGACY, ...FIXED, '', 'not-a-version']
    for (let major = 0; major <= 10; major++) {
      for (let minor = 0; minor <= 120; minor++)
        versions.push(`${major}.${minor}.3`)
    }
    for (const version of versions)
      expect(matchesSqlPredicate(version), version).toBe(isLegacyDownloadFailPlugin(version))
  })
})

describe('legacy download_fail correction', () => {
  it('subtracts legacy download_fail logs from version fails, never below zero', () => {
    const legacy = sumLegacyDownloadFails([
      { bucket: '2026-10-20', version_name: '8016', plugin_version: '8.51.16', count: '40' },
      { bucket: '2026-10-20', version_name: '8016', plugin_version: '8.50.0', count: 5 },
      // Fixed plugins send real download failures: they stay.
      { bucket: '2026-10-20', version_name: '8016', plugin_version: '8.53.0', count: 7 },
      { bucket: '2026-10-20', version_name: '8015', plugin_version: '7.20.0', count: 9 },
    ])
    expect(legacy.get(legacyDownloadFailKey('2026-10-20', '8016'))).toBe(45)

    const rows = [
      { date: '2026-10-20', version_name: '8016', install: 100, fail: 52 },
      { date: '2026-10-20', version_name: '8015', install: 3, fail: 4 },
      { date: '2026-10-21', version_name: '8016', install: 90, fail: 2 },
    ]
    expect(subtractLegacyDownloadFails(rows, row => legacyDownloadFailKey(row.date, row.version_name), legacy)).toEqual([
      { date: '2026-10-20', version_name: '8016', install: 100, fail: 7 },
      { date: '2026-10-20', version_name: '8015', install: 3, fail: 0 },
      { date: '2026-10-21', version_name: '8016', install: 90, fail: 2 },
    ])
  })
})
