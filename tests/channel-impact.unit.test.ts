import type { ChannelImpactChannelConfig, ChannelImpactDeviceGroup } from '../supabase/functions/_backend/utils/channel_impact.ts'
import { describe, expect, it } from 'vitest'
import { buildChannelImpactResponse } from '../supabase/functions/_backend/private/channel_impact.ts'
import { lintAnalyticsEngineSql } from '../supabase/functions/_backend/utils/analyticsEngineSqlLint.ts'
import { computeRequirement, countLegacySelfAssignmentDevices, estimateRolloutReceive, evaluateDeviceOutcome, summarizeChannelImpact } from '../supabase/functions/_backend/utils/channel_impact.ts'
import { buildChannelPopulationCFQuery, buildChannelPopulationCountCFQuery, channelImpactWindowStart, isoFromCF, toPopulationGroupsCF } from '../supabase/functions/_backend/utils/channel_impact_population.ts'

const openChannel: ChannelImpactChannelConfig = {
  disable_auto_update: 'none',
  disable_auto_update_under_native: false,
  ios: true,
  android: true,
  electron: true,
  allow_prod: true,
  allow_dev: true,
  allow_device: true,
  allow_emulator: true,
  assigned_devices_only: false,
}

function group(overrides: Partial<ChannelImpactDeviceGroup>): ChannelImpactDeviceGroup {
  return {
    platform: 'ios',
    version_build: '1.4.0',
    version_name: '1.4.2',
    plugin_version: '7.20.0',
    is_prod: true,
    is_emulator: false,
    device_count: 1,
    sample_device_id: `device-${Math.random().toString(36).slice(2, 8)}`,
    last_seen: '2026-11-17T08:00:00.000Z',
    ...overrides,
  }
}

const bundle = (name: string, minUpdate: string | null = null) => ({ kind: 'bundle' as const, name, min_update_version: minUpdate })

describe('channel impact outcomes', () => {
  it.concurrent('blocks a major bump on old native builds and lets new native builds through', () => {
    const channel = { ...openChannel, disable_auto_update: 'major' as const }
    expect(evaluateDeviceOutcome(group({ version_build: '1.9.0' }), channel, bundle('2.0.0'))).toBe('blocked_major')
    expect(evaluateDeviceOutcome(group({ version_build: '2.0.0' }), channel, bundle('2.0.0'))).toBe('receive')
    expect(evaluateDeviceOutcome(group({ version_build: '2.1.0' }), channel, bundle('2.0.0'))).toBe('receive_below_native')
    expect(computeRequirement(channel, bundle('2.0.0'))).toEqual({ strategy: 'major', native: '2.0.0' })
  })

  it.concurrent('applies minor, patch and metadata strategies against the native build', () => {
    expect(evaluateDeviceOutcome(group({ version_build: '1.4.0' }), { ...openChannel, disable_auto_update: 'minor' }, bundle('1.5.0'))).toBe('blocked_minor')
    expect(evaluateDeviceOutcome(group({ version_build: '1.5.3' }), { ...openChannel, disable_auto_update: 'minor' }, bundle('1.5.9'))).toBe('receive')
    expect(evaluateDeviceOutcome(group({ version_build: '1.4.0' }), { ...openChannel, disable_auto_update: 'patch' }, bundle('1.4.1'))).toBe('blocked_patch')
    const metadata = { ...openChannel, disable_auto_update: 'version_number' as const }
    expect(evaluateDeviceOutcome(group({ version_build: '1.4.0' }), metadata, bundle('1.6.0', '1.5.0'))).toBe('blocked_metadata')
    expect(evaluateDeviceOutcome(group({ version_build: '1.5.0' }), metadata, bundle('1.6.0', '1.5.0'))).toBe('receive')
    expect(evaluateDeviceOutcome(group({ version_build: '1.5.0' }), metadata, bundle('1.6.0'))).toBe('blocked_misconfigured')
    expect(computeRequirement(metadata, bundle('1.6.0', '1.5.0'))).toEqual({ strategy: 'metadata', native: '1.5.0' })
  })

  it.concurrent('keeps devices already on the bundle and honors the downgrade guard', () => {
    expect(evaluateDeviceOutcome(group({ version_name: '1.4.2' }), openChannel, bundle('1.4.2'))).toBe('already_on_target')
    const guarded = { ...openChannel, disable_auto_update_under_native: true }
    expect(evaluateDeviceOutcome(group({ version_build: '1.5.0' }), guarded, bundle('1.4.9'))).toBe('blocked_under_native')
  })

  it.concurrent('replays platform and build type switches', () => {
    expect(evaluateDeviceOutcome(group({ platform: 'android' }), { ...openChannel, android: false }, bundle('1.4.3'))).toBe('blocked_platform')
    expect(evaluateDeviceOutcome(group({ is_prod: false }), { ...openChannel, allow_dev: false }, bundle('1.4.3'))).toBe('blocked_build_type')
    expect(evaluateDeviceOutcome(group({ is_emulator: true }), { ...openChannel, allow_emulator: false }, bundle('1.4.3'))).toBe('blocked_build_type')
    expect(evaluateDeviceOutcome(group({ version_build: '' }), openChannel, bundle('1.4.3'))).toBe('unknown_native')
  })

  it.concurrent('only serves assigned devices on a private channel without self-assignment', () => {
    const privateChannel = { ...openChannel, assigned_devices_only: true }
    expect(evaluateDeviceOutcome(group({ forced: false }), privateChannel, bundle('1.4.3'))).toBe('blocked_private_channel')
    expect(evaluateDeviceOutcome(group({ forced: true }), privateChannel, bundle('1.4.3'))).toBe('receive')
    expect(evaluateDeviceOutcome(group({ forced: false }), privateChannel, { kind: 'builtin' })).toBe('blocked_private_channel')
    // Same order as /updates: the major gate answers first, the minor gate after.
    expect(evaluateDeviceOutcome(group({ version_build: '1.0.0' }), { ...privateChannel, disable_auto_update: 'major' }, bundle('2.0.0'))).toBe('blocked_major')
    expect(evaluateDeviceOutcome(group({ version_build: '1.0.0' }), { ...privateChannel, disable_auto_update: 'minor' }, bundle('1.1.0'))).toBe('blocked_private_channel')
  })

  it.concurrent('refuses an encrypted bundle to devices holding another key, like /updates', () => {
    const encrypted = { kind: 'bundle' as const, name: '1.4.3', min_update_version: null, key_id: 'key-bundle' }
    // Current key id format (plugin above 8.40.7): refused before anything else.
    expect(evaluateDeviceOutcome(group({ plugin_version: '8.41.0', key_id: 'key-device' }), openChannel, encrypted)).toBe('blocked_key_mismatch')
    expect(evaluateDeviceOutcome(group({ plugin_version: '8.41.0', key_id: 'key-device', version_name: '1.4.3' }), openChannel, encrypted)).toBe('blocked_key_mismatch')
    expect(evaluateDeviceOutcome(group({ plugin_version: '8.41.0', key_id: 'key-bundle' }), openChannel, encrypted)).toBe('receive')
    // Legacy key id format and devices without a key are not checked.
    expect(evaluateDeviceOutcome(group({ plugin_version: '8.40.7', key_id: 'key-device' }), openChannel, encrypted)).toBe('receive')
    expect(evaluateDeviceOutcome(group({ plugin_version: '8.41.0', key_id: '' }), openChannel, encrypted)).toBe('receive')
    expect(evaluateDeviceOutcome(group({ plugin_version: '8.41.0', key_id: 'key-device' }), openChannel, bundle('1.4.3'))).toBe('receive')
  })

  it.concurrent('only counts delta-only bundles for updaters and channels that can take a manifest', () => {
    const deltaOnly = { kind: 'bundle' as const, name: '1.4.3', min_update_version: null, has_zip: false }
    expect(evaluateDeviceOutcome(group({ plugin_version: '7.20.0' }), openChannel, deltaOnly)).toBe('receive')
    expect(evaluateDeviceOutcome(group({ plugin_version: '6.24.0' }), openChannel, deltaOnly)).toBe('blocked_no_bundle')
    expect(evaluateDeviceOutcome(group({ plugin_version: '7.0.34' }), openChannel, deltaOnly)).toBe('blocked_no_bundle')
    expect(evaluateDeviceOutcome(group({ plugin_version: '7.20.0' }), { ...openChannel, update_package: 'zip' }, deltaOnly)).toBe('blocked_no_bundle')
    // zip_from_builtin only forces zips for devices still on the store bundle.
    expect(evaluateDeviceOutcome(group({ plugin_version: '7.20.0', version_name: '1.4.0', version_build: '1.4.0' }), { ...openChannel, update_package: 'zip_from_builtin' }, deltaOnly)).toBe('blocked_no_bundle')
    expect(evaluateDeviceOutcome(group({ plugin_version: '7.20.0', version_name: '1.4.2', version_build: '1.4.0' }), { ...openChannel, update_package: 'zip_from_builtin' }, deltaOnly)).toBe('receive')
    // Bundles with a zip are never affected.
    expect(evaluateDeviceOutcome(group({ plugin_version: '6.24.0' }), openChannel, { ...deltaOnly, has_zip: true })).toBe('receive')
  })

  it.concurrent('reverts to the store bundle only where the plugin supports it', () => {
    const builtin = { kind: 'builtin' as const }
    expect(evaluateDeviceOutcome(group({ version_build: '1.4.0', version_name: '1.4.2' }), openChannel, builtin)).toBe('revert_to_builtin')
    expect(evaluateDeviceOutcome(group({ version_build: '1.4.0', version_name: '1.4.0' }), openChannel, builtin)).toBe('already_on_target')
    expect(evaluateDeviceOutcome(group({ plugin_version: '5.9.0' }), openChannel, builtin)).toBe('plugin_too_old')
    // Strategies never gate the store bundle.
    expect(evaluateDeviceOutcome(group({ version_build: '1.0.0', version_name: '1.4.2' }), { ...openChannel, disable_auto_update: 'major' }, builtin)).toBe('revert_to_builtin')
  })
})

describe('channel impact summary', () => {
  const groups = [
    group({ version_build: '1.9.0', version_name: '1.9.4', device_count: 700, sample_device_id: 'old-ios' }),
    group({ platform: 'android', version_build: '1.9.0', version_name: '1.9.4', device_count: 200, sample_device_id: 'old-android' }),
    group({ version_build: '2.0.0', version_name: '2.0.0', device_count: 60, sample_device_id: 'new-ios' }),
    group({ version_build: '2.0.1', version_name: '1.9.4', device_count: 30, sample_device_id: 'newer-ios' }),
    group({ version_build: '', version_name: '1.9.4', device_count: 10, sample_device_id: 'unknown' }),
  ]

  it.concurrent('counts the ratio that receives a major bump and explains the rest', () => {
    const summary = summarizeChannelImpact(groups, { ...openChannel, disable_auto_update: 'major' }, bundle('2.0.0'))
    expect(summary.total_devices).toBe(1000)
    expect(summary.outcomes.blocked_major).toBe(900)
    expect(summary.outcomes.receive_below_native).toBe(30)
    expect(summary.receive).toBe(30)
    expect(summary.outcomes.unknown_native).toBe(10)
    expect(summary.requirement).toEqual({ strategy: 'major', native: '2.0.0' })
    expect(summary.native_versions[0]).toMatchObject({ platform: 'ios', version_build: '1.9.0', device_count: 700, outcome: 'blocked_major', receive: 0, mixed: false })
    // Store build 2.0.0 holds 60 devices already on it and nothing else; 2.0.1 receives.
    expect(summary.native_versions.find(native => native.version_build === '2.0.0')).toMatchObject({ mixed: false, outcome: 'already_on_target' })
    const mixed = summarizeChannelImpact([
      group({ version_build: '1.9.0', version_name: '1.9.4', device_count: 60 }),
      group({ version_build: '1.9.0', version_name: '2.0.0', device_count: 40 }),
    ], openChannel, bundle('2.0.0'))
    expect(mixed.native_versions[0]).toMatchObject({ device_count: 100, receive: 60, outcome: 'receive', mixed: true })
  })

  it.concurrent('picks at most three meaningful example devices', () => {
    const summary = summarizeChannelImpact(groups, { ...openChannel, disable_auto_update: 'major' }, bundle('2.0.0'))
    expect(summary.samples).toHaveLength(3)
    // One that gets it (even a small setup), the main blocker, then another outcome.
    expect(summary.samples.map(sample => sample.device_id)).toEqual(['newer-ios', 'old-ios', 'new-ios'])
    expect(summary.samples.map(sample => sample.outcome)).toEqual(['receive_below_native', 'blocked_major', 'already_on_target'])
    // Nobody receives: the main blockers first, other store builds after.
    const blocked = summarizeChannelImpact([
      group({ version_build: '1.9.0', device_count: 700, sample_device_id: 'a' }),
      group({ platform: 'android', version_build: '1.9.0', device_count: 200, sample_device_id: 'b' }),
      group({ version_build: '1.8.0', device_count: 100, sample_device_id: 'c' }),
    ], { ...openChannel, disable_auto_update: 'major' }, bundle('2.0.0'))
    expect(blocked.samples.map(sample => sample.device_id)).toEqual(['a', 'b', 'c'])
  })

  it.concurrent('treats 4.x updaters like /updates: rejected before any channel gate', () => {
    expect(evaluateDeviceOutcome(group({ plugin_version: '4.20.0' }), openChannel, bundle('1.4.3'))).toBe('plugin_too_old')
    expect(evaluateDeviceOutcome(group({ plugin_version: '4.20.0', version_name: '1.4.3' }), openChannel, bundle('1.4.3'))).toBe('plugin_too_old')
  })

  it.concurrent('estimates the first wave of a progressive rollout', () => {
    expect(estimateRolloutReceive(900, 1000)).toBe(90)
    expect(estimateRolloutReceive(3, 10000)).toBe(3)
    expect(estimateRolloutReceive(3, 0)).toBe(0)
  })

  it.concurrent('builds one response for several targets from the same population', () => {
    const row = {
      id: 7,
      name: 'production',
      public: true,
      allow_device_self_set: false,
      update_package: 'all' as const,
      paused_at: null,
      disable_auto_update: 'none' as const,
      disable_auto_update_under_native: true,
      ...{ ios: true, android: true, electron: false, allow_prod: true, allow_dev: true, allow_device: true, allow_emulator: true },
      rollout_enabled: false,
      rollout_percentage_bps: 0,
      rollout_paused_at: null,
      current_bundle: { id: 3, name: '1.9.4' },
      rollout_bundle: null,
      previous_bundle: { id: 2, name: '1.9.3', min_update_version: null },
      bundles: [{ id: 5, name: '2.0.0', min_update_version: null, deleted: false }],
      app_allows_self_assignment: true,
    }
    const population = { groups, total_devices: 1000, truncated: false }
    const response = buildChannelImpactResponse('com.example.app', row, population, [{ kind: 'previous' }, { kind: 'builtin' }, { kind: 'bundle', version_id: 5 }], {
      mode: 'rollout',
      rolloutPercentageBps: 2500,
      includeSamples: false,
      now: new Date('2026-11-17T10:00:00.000Z'),
    })
    expect(response.previous_bundle).toEqual({ id: 2, name: '1.9.3' })
    expect(response.impacts.map(impact => impact.target)).toEqual([
      { kind: 'bundle', id: 2, name: '1.9.3' },
      { kind: 'builtin', id: null, name: 'builtin' },
      { kind: 'bundle', id: 5, name: '2.0.0' },
    ])
    // 1.9.3 is below the 2.0.x native builds and the downgrade guard is on.
    expect(response.impacts[0].outcomes.blocked_under_native).toBe(90)
    expect(response.impacts[1].outcomes.revert_to_builtin).toBe(930)
    expect(response.impacts[2].rollout_receive).toBe(Math.round(response.impacts[2].receive / 4))
    expect(response.impacts.every(impact => impact.samples.length === 0)).toBe(true)
    expect(response.overrides_truncated).toBe(false)
    // The test setups use updater 7.20.0, which keeps self-assignments in the legacy store.
    expect(response.legacy_self_assignment_devices).toBe(1000)
    expect(buildChannelImpactResponse('com.example.app', { ...row, app_allows_self_assignment: false }, population, [{ kind: 'builtin' }], { includeSamples: false }).legacy_self_assignment_devices).toBe(0)
    expect(countLegacySelfAssignmentDevices([group({ plugin_version: '7.40.0', device_count: 4 }), group({ plugin_version: '6.30.0', device_count: 3 })])).toBe(3)
    const capped = buildChannelImpactResponse('com.example.app', row, { ...population, overrides_truncated: true }, [{ kind: 'builtin' }], { includeSamples: false })
    expect(capped.overrides_truncated).toBe(true)
  })
})

describe('channel population query', () => {
  const windowStart = channelImpactWindowStart(Date.parse('2026-11-17T10:00:30.000Z'))

  it.concurrent('rounds the window to the minute so the SQL text is stable', () => {
    expect(windowStart.toISOString()).toBe('2026-10-18T10:00:00.000Z')
  })

  it.concurrent('builds Analytics Engine SQL the linter accepts', () => {
    const overrides = { into: ['forced-in'], elsewhere: ['forced-out'], defaultForPlatforms: ['ios' as const] }
    const query = buildChannelPopulationCFQuery('com.example.app', 'production', overrides, windowStart)
    expect(lintAnalyticsEngineSql(query)).toEqual([])
    expect(query).toContain('timestamp > toDateTime(\'2026-10-18 10:00:00\')')
    expect(query).toContain('lower(device_id) IN (\'forced-in\')')
    // Analytics Engine rejects Integer literals against the Double platform column.
    expect(query).toContain('platform IN (1.0)')
    expect(query).toContain('LIMIT 500')
    expect(query).toContain('if(lower(blob1) IN (\'forced-in\'), 1, 0) AS forced')
    expect(query).toContain('argMax(blob8, timestamp) AS key_id')
    expect(query).toContain('GROUP BY forced, key_id, platform')
    expect(lintAnalyticsEngineSql(buildChannelPopulationCountCFQuery('com.example.app', 'production', overrides, windowStart))).toEqual([])
  })

  it.concurrent('escapes app and channel names', () => {
    const query = buildChannelPopulationCFQuery('com.example.app', 'it\'s', undefined, windowStart)
    expect(query).toContain('default_channel = \'it\'\'s\'')
  })

  it.concurrent('accepts the Date objects runQueryToCFA returns for DateTime columns', () => {
    expect(isoFromCF(new Date('2026-11-17T09:30:00.000Z'))).toBe('2026-11-17T09:30:00.000Z')
    expect(isoFromCF('2026-11-17 09:30:00')).toBe('2026-11-17T09:30:00.000Z')
    expect(isoFromCF(new Date('invalid'))).toBeNull()
    const [row] = toPopulationGroupsCF([{ platform: 0, version_build: '1.0.0', version_name: '1.0.0', plugin_version: '7.0.0', is_prod: 1, is_emulator: 0, device_count: 3, sample_device_id: 'x', latest_seen: new Date('2026-11-17T09:30:00.000Z') }])
    expect(row.last_seen).toBe('2026-11-17T09:30:00.000Z')
  })

  it.concurrent('maps Analytics Engine rows to device setups', () => {
    expect(toPopulationGroupsCF([{
      forced: 1,
      key_id: 'k1',
      platform: 1,
      version_build: '2.0.0',
      version_name: '2.0.0',
      plugin_version: '7.1.0',
      is_prod: 1,
      is_emulator: -1,
      device_count: '12',
      sample_device_id: 'abc',
      latest_seen: '2026-11-17 09:30:00',
    }])).toEqual([{
      platform: 'ios',
      version_build: '2.0.0',
      version_name: '2.0.0',
      plugin_version: '7.1.0',
      is_prod: true,
      is_emulator: null,
      device_count: 12,
      forced: true,
      key_id: 'k1',
      sample_device_id: 'abc',
      last_seen: '2026-11-17T09:30:00.000Z',
    }])
  })
})
