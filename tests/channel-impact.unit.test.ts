import type { ChannelImpactChannelConfig, ChannelImpactDeviceGroup } from '../supabase/functions/_backend/utils/channel_impact.ts'
import { describe, expect, it } from 'vitest'
import { buildChannelImpactResponse } from '../supabase/functions/_backend/private/channel_impact.ts'
import { lintAnalyticsEngineSql } from '../supabase/functions/_backend/utils/analyticsEngineSqlLint.ts'
import { computeRequirement, estimateRolloutReceive, evaluateDeviceOutcome, summarizeChannelImpact } from '../supabase/functions/_backend/utils/channel_impact.ts'
import { buildChannelPopulationCFQuery, buildChannelPopulationCountCFQuery, channelImpactWindowStart, toPopulationGroupsCF } from '../supabase/functions/_backend/utils/channel_impact_population.ts'

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
    expect(summary.native_versions[0]).toMatchObject({ platform: 'ios', version_build: '1.9.0', device_count: 700, outcome: 'blocked_major', receive: 0 })
  })

  it.concurrent('picks real example devices covering each distinct outcome first', () => {
    const summary = summarizeChannelImpact(groups, { ...openChannel, disable_auto_update: 'major' }, bundle('2.0.0'))
    expect(summary.samples.length).toBeGreaterThanOrEqual(3)
    expect(summary.samples.length).toBeLessThanOrEqual(5)
    const outcomes = summary.samples.map(sample => sample.outcome)
    expect(outcomes.slice(0, 4)).toEqual(['blocked_major', 'already_on_target', 'receive_below_native', 'unknown_native'])
    expect(summary.samples[0].device_id).toBe('old-ios')
    // The fifth example is another setup (Android on the old native build).
    expect(summary.samples[4]).toMatchObject({ device_id: 'old-android', outcome: 'blocked_major' })
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
    expect(query).toContain('GROUP BY forced, platform')
    expect(lintAnalyticsEngineSql(buildChannelPopulationCountCFQuery('com.example.app', 'production', overrides, windowStart))).toEqual([])
  })

  it.concurrent('escapes app and channel names', () => {
    const query = buildChannelPopulationCFQuery('com.example.app', 'it\'s', undefined, windowStart)
    expect(query).toContain('default_channel = \'it\'\'s\'')
  })

  it.concurrent('maps Analytics Engine rows to device setups', () => {
    expect(toPopulationGroupsCF([{
      forced: 1,
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
      sample_device_id: 'abc',
      last_seen: '2026-11-17T09:30:00.000Z',
    }])
  })
})
