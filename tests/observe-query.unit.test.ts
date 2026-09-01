import { describe, expect, it } from 'vitest'
import {
  buildObserveFindings,
  buildObserveHandoffPrompt,
  extractRoute,
  groupObserveRoutes,
  normalizeObserveDays,
  sortObserveSamples,
  toObserveSample,
} from '../supabase/functions/_backend/utils/observeQuery.ts'

describe('observe query helpers', () => {
  it.concurrent('flags slow launch and the top crash as actionable findings', () => {
    const findings = buildObserveFindings({
      overview: {
        total_events: 40,
        total_devices: 10,
        issue_count: 8,
        issue_free_rate: 70,
        launch_timeout_count: 2,
        launch_p90_ms: 5200,
        webview_load_p90_ms: 800,
      },
      actionBreakdown: [
        { action: 'app_crash_native', events: 6, devices: 4, p90_ms: null, is_issue: true },
        { action: 'app_launch_ready', events: 20, devices: 10, p90_ms: 5200, is_issue: false },
      ],
      versions: [
        { version_name: '1.2.0', devices: 8, issue_free_rate: 62, launch_p90_ms: 5400 },
      ],
    })

    expect(findings.map(finding => finding.id)).toEqual(expect.arrayContaining([
      'launch_p90_critical',
      'launch_timeouts',
      'issue_free_critical',
      'top_issue',
      'slow_version',
    ]))
    expect(findings.find(finding => finding.id === 'top_issue')?.next).toMatchObject({
      view: 'events',
      action: 'app_crash_native',
    })
    expect(findings.find(finding => finding.id === 'launch_p90_critical')?.next).toMatchObject({
      view: 'metrics',
      action: 'app_launch_ready',
      sort: 'slowest',
    })
  })

  it.concurrent('returns a no-data finding when nothing was reported', () => {
    const findings = buildObserveFindings({
      overview: {
        total_events: 0,
        total_devices: 0,
        issue_count: 0,
        issue_free_rate: null,
        launch_timeout_count: 0,
        launch_p90_ms: null,
        webview_load_p90_ms: null,
      },
      actionBreakdown: [],
      versions: [],
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]?.id).toBe('no_data')
  })

  it.concurrent('groups navigation samples by metadata.route without an Expo router', () => {
    const samples = [
      toObserveSample({ device_id: 'd1', action: 'app_nav', created_at: '2026-09-01T10:00:00Z', metadata: { route: '/home', duration_ms: '120' } }),
      toObserveSample({ device_id: 'd2', action: 'app_nav', created_at: '2026-09-01T10:01:00Z', metadata: { route: '/checkout', duration_ms: '900' } }),
      toObserveSample({ device_id: 'd3', action: 'webview_page_loaded', created_at: '2026-09-01T10:02:00Z', metadata: { path: '/checkout', duration_ms: '1100' } }),
      toObserveSample({ device_id: 'd4', action: 'app_launch_ready', created_at: '2026-09-01T10:03:00Z', metadata: { duration_ms: '400' } }),
    ]
    const routes = groupObserveRoutes(samples)
    expect(routes[0]).toMatchObject({ route: '/checkout', events: 2, devices: 2 })
    expect(routes[0]?.p90_ms).toBeGreaterThan(900)
    expect(extractRoute({ path: '/settings' })).toBe('/settings')
    expect(extractRoute({ route: 12 } as Record<string, unknown>)).toBeNull()
    expect(toObserveSample({
      device_id: 'bad',
      action: 'app_launch_ready',
      created_at: '2026-09-01T10:04:00Z',
      metadata: { duration_ms: '999999999' },
    }).duration_ms).toBeNull()
  })

  it.concurrent('sorts samples slowest-first and builds a handoff prompt for agents', () => {
    const samples = sortObserveSamples([
      toObserveSample({ device_id: 'fast', action: 'app_launch_ready', created_at: '2026-09-01T10:00:00Z', metadata: { duration_ms: '200' } }),
      toObserveSample({ device_id: 'slow', action: 'app_launch_ready', created_at: '2026-09-01T10:01:00Z', metadata: { duration_ms: '4000' } }),
    ], 'slowest')
    expect(samples[0]?.device_id).toBe('slow')
    expect(normalizeObserveDays(14)).toBeNull()
    expect(normalizeObserveDays(7)).toBe(7)

    const prompt = buildObserveHandoffPrompt({
      appId: 'com.demo.app',
      days: 7,
      overview: {
        total_events: 10,
        total_devices: 4,
        issue_count: 1,
        issue_free_rate: 75,
        launch_timeout_count: 0,
        launch_p90_ms: 4100,
        webview_load_p90_ms: 200,
      },
      findings: buildObserveFindings({
        overview: {
          total_events: 10,
          total_devices: 4,
          issue_count: 1,
          issue_free_rate: 75,
          launch_timeout_count: 0,
          launch_p90_ms: 4100,
          webview_load_p90_ms: 200,
        },
        actionBreakdown: [{ action: 'app_crash', events: 1, devices: 1, p90_ms: null, is_issue: true }],
        versions: [],
      }),
    })
    expect(prompt).toContain('com.demo.app')
    expect(prompt).toContain('view=metrics')
    expect(prompt).toContain('Start with view=summary')
  })
})
