import { describe, expect, it } from 'vitest'
import { buildStatsInsightsFromRows } from '../supabase/functions/_backend/utils/stats.ts'

describe('stats insights helpers', () => {
  it.concurrent('groups failure logs by action, day, version, and device', () => {
    const insights = buildStatsInsightsFromRows([
      { action: 'download_fail', device_id: 'device-a', version_name: '1.0.0', created_at: '2026-01-01T10:00:00Z' },
      { action: 'download_fail', device_id: 'device-a', version_name: '1.0.0', created_at: '2026-01-01T11:00:00Z' },
      { action: 'download_fail', device_id: 'device-b', version_name: '1.1.0', created_at: '2026-01-02T10:00:00Z' },
      { action: 'app_crash', device_id: 'device-c', version_name: '1.1.0', created_at: '2026-01-02T12:00:00Z' },
    ])

    expect(insights.summary).toEqual({ total: 4, device_count: 3, action_count: 2 })
    expect(insights.actions[0]).toMatchObject({
      action: 'download_fail',
      total: 3,
      device_count: 2,
      version_count: 2,
      latest_device_id: 'device-b',
      latest_version_name: '1.1.0',
    })
    expect(insights.daily).toEqual([
      { date: '2026-01-01', action: 'download_fail', total: 2 },
      { date: '2026-01-02', action: 'download_fail', total: 1 },
      { date: '2026-01-02', action: 'app_crash', total: 1 },
    ])
    expect(insights.versions[0]).toMatchObject({ action: 'download_fail', version_name: '1.0.0', total: 2, device_count: 1 })
    expect(insights.devices[0]).toMatchObject({ action: 'download_fail', device_id: 'device-a', total: 2, version_name: '1.0.0' })
  })
})
