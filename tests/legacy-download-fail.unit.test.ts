import { describe, expect, it } from 'vitest'
import { countsAsBundleFailure as countsAsBundleFailurePlugin, isLegacyDownloadFailPlugin as isLegacyPlugin } from '../supabase/functions/_backend/plugin_runtime/utils/legacyDownloadFail.ts'
import { countsAsBundleFailure, isLegacyDownloadFailPlugin, legacyDownloadFailKey, legacyDownloadFailPluginSqlCF, mergeLegacyCheckFailures, subtractLegacyDownloadFails, sumLegacyDownloadFails, summarizeLegacyCheckFailures, UPDATE_CHECK_ERROR_MIN_PLUGIN_VERSION } from '../supabase/functions/_backend/utils/legacyDownloadFail.ts'
import { formatLegacyPluginVersions } from '../src/composables/useReleaseLive.ts'
import { lintAnalyticsEngineSql } from '../supabase/functions/_backend/utils/analyticsEngineSqlLint.ts'
import { buildLegacyCheckFailuresQueryCF } from '../supabase/functions/_backend/utils/cloudflare.ts'

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

  it.concurrent('summarizes legacy download_fail per bundle for the dashboard notice', () => {
    const summary = summarizeLegacyCheckFailures([
      { version_name: '8016', plugin_version: '8.51.16', count: '450' },
      { version_name: '8016', plugin_version: '8.9.0', count: 5 },
      { version_name: '8016', plugin_version: '8.53.0', count: 20 },
      { version_name: '8015', plugin_version: '6.40.0', count: 9 },
      { version_name: '8015', plugin_version: '8.51.16', count: 0 },
    ])
    expect(summary).toEqual([
      { version_name: '8016', excluded: 455, plugin_versions: ['8.9.0', '8.51.16'] },
      { version_name: '8015', excluded: 9, plugin_versions: ['6.40.0'] },
    ])

    expect(mergeLegacyCheckFailures([])).toBeNull()
    // Only the given bundles' plugin versions.
    expect(mergeLegacyCheckFailures(summary.filter(bundle => bundle.version_name === '8015'))).toEqual({ excluded: 9, plugin_versions: ['6.40.0'], fixed_in: UPDATE_CHECK_ERROR_MIN_PLUGIN_VERSION })
    expect(mergeLegacyCheckFailures(summary)).toEqual({ excluded: 464, plugin_versions: ['6.40.0', '8.9.0', '8.51.16'], fixed_in: UPDATE_CHECK_ERROR_MIN_PLUGIN_VERSION })
  })

  it.concurrent('lists the newest plugin versions in the notice', () => {
    expect(formatLegacyPluginVersions(['8.51.15', '8.51.16'])).toBe('8.51.15, 8.51.16')
    expect(formatLegacyPluginVersions(['6.1.0', '7.2.0', '8.1.0', '8.51.15', '8.51.16'])).toBe('8.1.0, 8.51.15, 8.51.16 +2')
  })

  it.concurrent('sizes the notice from the channel and the bundle unattributed logs', () => {
    const query = buildLegacyCheckFailuresQueryCF({
      appId: 'com.demo\'app',
      start: new Date('2026-10-23T13:00:00.000Z'),
      end: new Date('2026-10-26T13:00:00.000Z'),
      channel: { id: 7, name: 'prod\'uction' },
      versionNames: ['1.0.0'],
    })
    expect(lintAnalyticsEngineSql(query)).toEqual([])
    expect(query).toContain('index1 = \'com.demo\'\'app\'')
    expect(query).toContain('blob3 IN (\'1.0.0\')')
    expect(query).toContain(legacyDownloadFailPluginSqlCF('blob7'))
    // Flagged logs are ignored too, so the flag is not filtered.
    expect(query).not.toContain('blob10')
    // Legacy logs recorded since the fix carry no channel.
    expect(query).toContain('AND ((blob9 = \'7\' OR (blob9 = \'\' AND blob8 = \'prod\'\'uction\')) OR (blob8 = \'\' AND blob9 = \'\'))')

    const allChannels = buildLegacyCheckFailuresQueryCF({ appId: 'com.demo.app', start: new Date(0), end: new Date(1) })
    expect(lintAnalyticsEngineSql(allChannels)).toEqual([])
    expect(allChannels).not.toContain('blob8')
  })
})
