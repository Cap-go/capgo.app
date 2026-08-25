import { describe, expect, it } from 'vitest'
import { nativeObserveStatsTestUtils } from '../supabase/functions/_backend/private/native_observe_stats.ts'

describe('native observe stats helpers', () => {
  it.concurrent('normalizes supported period presets', () => {
    expect(nativeObserveStatsTestUtils.normalizeNativeObservePeriodDays(undefined)).toBe(7)
    expect(nativeObserveStatsTestUtils.normalizeNativeObservePeriodDays(1)).toBe(1)
    expect(nativeObserveStatsTestUtils.normalizeNativeObservePeriodDays(3)).toBe(3)
    expect(nativeObserveStatsTestUtils.normalizeNativeObservePeriodDays(7)).toBe(7)
    expect(nativeObserveStatsTestUtils.normalizeNativeObservePeriodDays(30)).toBe(30)
    expect(nativeObserveStatsTestUtils.normalizeNativeObservePeriodDays(2)).toBeNull()
    expect(nativeObserveStatsTestUtils.normalizeNativeObservePeriodDays(7.5)).toBeNull()
  })

  it.concurrent('normalizes supported views', () => {
    expect(nativeObserveStatsTestUtils.normalizeNativeObserveView(undefined)).toBe('global')
    expect(nativeObserveStatsTestUtils.normalizeNativeObserveView('global')).toBe('global')
    expect(nativeObserveStatsTestUtils.normalizeNativeObserveView('plugins')).toBe('plugins')
    expect(nativeObserveStatsTestUtils.normalizeNativeObserveView('unknown')).toBeNull()
  })

  it.concurrent('normalizes supported version groups', () => {
    expect(nativeObserveStatsTestUtils.normalizeNativeObserveVersionGroup(undefined)).toBe('version')
    expect(nativeObserveStatsTestUtils.normalizeNativeObserveVersionGroup('version')).toBe('version')
    expect(nativeObserveStatsTestUtils.normalizeNativeObserveVersionGroup('version_platform')).toBe('version_platform')
    expect(nativeObserveStatsTestUtils.normalizeNativeObserveVersionGroup('version_platform_channel')).toBe('version_platform_channel')
    expect(nativeObserveStatsTestUtils.normalizeNativeObserveVersionGroup('unknown')).toBeNull()
  })

  it.concurrent('generates inclusive UTC day labels', () => {
    expect(nativeObserveStatsTestUtils.generateDateLabels(
      new Date('2026-07-01T18:00:00Z'),
      new Date('2026-07-03T02:00:00Z'),
    )).toEqual(['2026-07-01', '2026-07-02', '2026-07-03'])
  })

  it.concurrent('builds daily timing, issue, action, and version aggregates', () => {
    const response = nativeObserveStatsTestUtils.buildNativeObserveResponse({
      labels: ['2026-07-01', '2026-07-02'],
      days: 7,
      start: '2026-07-01T00:00:00.000Z',
      end: '2026-07-02T23:59:59.999Z',
      versionGroup: 'version',
      dailyRows: [
        { day: '2026-07-01', action: 'app_launch_ready', events: 4, devices: 3, p50_ms: 410.4, p90_ms: 912.8, p99_ms: 1200 },
        { day: '2026-07-01', action: 'webview_page_loaded', events: 3, devices: 2, p50_ms: 720, p90_ms: 1450, p99_ms: 1800 },
        { day: '2026-07-02', action: 'app_crash', events: 1, devices: 1, p50_ms: null, p90_ms: null, p99_ms: null },
      ],
      actionRows: [
        { action: 'app_launch_ready', events: 4, devices: 3, p50_ms: 410.4, p90_ms: 912.8, p99_ms: 1200 },
        { action: 'app_crash', events: 1, devices: 1, p50_ms: null, p90_ms: null, p99_ms: null },
      ],
      versionRows: [
        { version_name: '1.2.3', events: 8, devices: 4, issue_count: 1, affected_devices: 1, launch_p90_ms: 912.8, webview_load_p90_ms: 1450 },
      ],
      overviewRow: {
        events: 8,
        devices: 4,
        issue_count: 1,
        affected_devices: 1,
        launch_timeout_count: 0,
        launch_p50_ms: 410.4,
        launch_p90_ms: 912.8,
        webview_load_p50_ms: 720,
        webview_load_p90_ms: 1450,
      },
      releaseMarkers: [
        { version_name: '1.2.3', channel_name: 'production', deployed_at: '2026-07-01T12:00:00.000Z' },
      ],
    })

    expect(response.overview.issue_free_rate).toBe(75)
    expect(response.overview.launch_p90_ms).toBe(913)
    expect(response.version_group).toBe('version')
    expect(response.daily.launches).toEqual([4, 0])
    expect(response.daily.webview_loads).toEqual([3, 0])
    expect('pluginVersions' in response).toBe(false)
    expect(response.daily.issue_events).toEqual([0, 1])
    expect(response.daily.launch_p50_ms).toEqual([410, null])
    expect(response.actionBreakdown[1]).toMatchObject({ action: 'app_crash', is_issue: true })
    expect(response.versions[0]).toMatchObject({ version_name: '1.2.3', platform: null, channel_name: null, issue_free_rate: 75, launch_p90_ms: 913 })
    expect(response.releaseMarkers).toHaveLength(1)
  })

  it.concurrent('returns null issue-free rate when no devices are tracked', () => {
    const response = nativeObserveStatsTestUtils.buildNativeObserveResponse({
      labels: ['2026-07-01'],
      days: 1,
      start: '2026-07-01T00:00:00.000Z',
      end: '2026-07-01T23:59:59.999Z',
      dailyRows: [],
      actionRows: [],
      versionRows: [
        { version_name: '1.0.0', events: 0, devices: 0, issue_count: 0, affected_devices: 0, launch_p90_ms: null, webview_load_p90_ms: null },
      ],
      overviewRow: {
        events: 0,
        devices: 0,
        issue_count: 0,
        affected_devices: 0,
        launch_timeout_count: 0,
        launch_p50_ms: null,
        launch_p90_ms: null,
        webview_load_p50_ms: null,
        webview_load_p90_ms: null,
      },
      releaseMarkers: [],
    })

    expect(response.overview.total_devices).toBe(0)
    expect(response.overview.issue_free_rate).toBeNull()
    expect(response.versions[0].issue_free_rate).toBeNull()
  })

  it.concurrent('builds plugin version aggregates without global statistics', () => {
    expect(nativeObserveStatsTestUtils.buildNativeObservePluginResponse([
      { plugin_version: '7.0.0', devices: 3, total_devices: 4 },
      { plugin_version: '6.9.0', devices: 1, total_devices: 4 },
    ])).toEqual({
      pluginVersions: [
        { plugin_version: '7.0.0', devices: 3, total_devices: 4 },
        { plugin_version: '6.9.0', devices: 1, total_devices: 4 },
      ],
    })
  })

  it.concurrent('parses duration metadata strings', () => {
    expect(nativeObserveStatsTestUtils.parseMetaDurationMs({ duration_ms: '1250.5' })).toBe(1250.5)
    expect(nativeObserveStatsTestUtils.parseMetaDurationMs({ duration: '900' })).toBe(900)
    expect(nativeObserveStatsTestUtils.parseMetaDurationMs({ duration_ms: 'nope' })).toBeNull()
    expect(nativeObserveStatsTestUtils.parseMetaDurationMs(null)).toBeNull()
  })

  it.concurrent('aggregates CF observe samples into daily/action/version/overview rows', () => {
    const aggregates = nativeObserveStatsTestUtils.aggregateNativeObserveSamples([
      {
        day: '2026-07-01',
        action: 'app_launch_ready',
        version_name: '1.2.3',
        device_id: 'd1',
        duration_ms: 400,
      },
      {
        day: '2026-07-01',
        action: 'app_launch_ready',
        version_name: '1.2.3',
        device_id: 'd2',
        duration_ms: 800,
      },
      {
        day: '2026-07-01',
        action: 'webview_page_loaded',
        version_name: '1.2.3',
        device_id: 'd1',
        duration_ms: 1200,
      },
      {
        day: '2026-07-02',
        action: 'app_crash',
        version_name: '1.2.3',
        device_id: 'd3',
        duration_ms: null,
      },
      {
        day: '2026-07-02',
        action: 'app_launch_timeout',
        version_name: '1.2.4',
        device_id: 'd3',
        duration_ms: null,
      },
    ])

    expect(aggregates.overviewRow).toMatchObject({
      events: 5,
      devices: 3,
      issue_count: 2,
      affected_devices: 1,
      launch_timeout_count: 1,
    })
    expect(aggregates.overviewRow.launch_p50_ms).toBe(600)
    expect(aggregates.overviewRow.webview_load_p90_ms).toBe(1200)

    expect(aggregates.dailyRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ day: '2026-07-01', action: 'app_launch_ready', events: 2, devices: 2 }),
      expect.objectContaining({ day: '2026-07-02', action: 'app_crash', events: 1, devices: 1, p50_ms: null }),
    ]))

    expect(aggregates.actionRows[0]).toMatchObject({ action: 'app_launch_ready', events: 2, devices: 2 })
    expect(aggregates.versionRows).toEqual([
      expect.objectContaining({ version_name: '1.2.3', events: 4, devices: 3, issue_count: 1, affected_devices: 1 }),
      expect.objectContaining({ version_name: '1.2.4', events: 1, devices: 1, issue_count: 1, affected_devices: 1 }),
    ])
  })

  it.concurrent('aggregates version rows by platform and channel when requested', () => {
    const aggregates = nativeObserveStatsTestUtils.aggregateNativeObserveSamples([
      {
        day: '2026-07-01',
        action: 'app_launch_ready',
        version_name: '1.0.0',
        device_id: 'android-prod',
        duration_ms: 400,
        platform: 'android',
        channel_name: 'production',
      },
      {
        day: '2026-07-01',
        action: 'app_launch_ready',
        version_name: '1.0.0',
        device_id: 'android-beta',
        duration_ms: 500,
        platform: 'android',
        channel_name: 'beta',
      },
      {
        day: '2026-07-01',
        action: 'app_launch_ready',
        version_name: '1.0.0',
        device_id: 'ios-prod',
        duration_ms: 450,
        platform: 'ios',
        channel_name: 'production',
      },
    ], 'version_platform_channel')

    expect(aggregates.versionRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ version_name: '1.0.0', platform: 'android', channel_name: 'production', devices: 1, events: 1 }),
      expect.objectContaining({ version_name: '1.0.0', platform: 'android', channel_name: 'beta', devices: 1, events: 1 }),
      expect.objectContaining({ version_name: '1.0.0', platform: 'ios', channel_name: 'production', devices: 1, events: 1 }),
    ]))
    expect(aggregates.versionRows).toHaveLength(3)
  })

  it.concurrent('aggregates version rows by platform when channel grouping is not requested', () => {
    const aggregates = nativeObserveStatsTestUtils.aggregateNativeObserveSamples([
      {
        day: '2026-07-01',
        action: 'app_launch_ready',
        version_name: '1.0.0',
        device_id: 'android-prod',
        duration_ms: 400,
        platform: 'android',
        channel_name: 'production',
      },
      {
        day: '2026-07-01',
        action: 'app_launch_ready',
        version_name: '1.0.0',
        device_id: 'android-beta',
        duration_ms: 500,
        platform: 'android',
        channel_name: 'beta',
      },
      {
        day: '2026-07-01',
        action: 'app_launch_ready',
        version_name: '1.0.0',
        device_id: 'ios-prod',
        duration_ms: 450,
        platform: 'ios',
        channel_name: 'production',
      },
    ], 'version_platform')

    expect(aggregates.versionRows).toEqual([
      expect.objectContaining({
        version_name: '1.0.0',
        platform: 'android',
        channel_name: null,
        devices: 2,
        events: 2,
      }),
      expect.objectContaining({
        version_name: '1.0.0',
        platform: 'ios',
        channel_name: null,
        devices: 1,
        events: 1,
      }),
    ])
    expect(aggregates.versionRows).toHaveLength(2)
  })

  it.concurrent('maps CF timing events into observe samples', () => {
    expect(nativeObserveStatsTestUtils.toNativeObserveEventSamples([
      {
        app_id: 'com.demo.app',
        device_id: 'd1',
        action: 'app_launch_ready',
        version_name: '1.0.0',
        metadata: { duration_ms: '450' },
        duration_ms: null,
        created_at: '2026-07-02T10:00:00.000Z',
      },
      {
        app_id: 'com.demo.app',
        device_id: 'd2',
        action: 'app_crash',
        version_name: '',
        metadata: null,
        duration_ms: null,
        created_at: 'not-a-date',
      },
    ])).toEqual([
      {
        day: '2026-07-02',
        action: 'app_launch_ready',
        version_name: '1.0.0',
        device_id: 'd1',
        duration_ms: 450,
      },
    ])
  })

})
