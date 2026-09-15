import { describe, expect, it } from 'vitest'
import { buildDailyDeviceUpdateOutcomesFromRows } from '../supabase/functions/_backend/utils/stats.ts'

describe('update device outcomes', () => {
  it.concurrent('counts one device-day failure when set does not follow fail the same day', () => {
    const rows = buildDailyDeviceUpdateOutcomesFromRows([
      { device_id: 'device-a', action: 'download_fail', created_at: '2026-01-01T10:00:00Z' },
      { device_id: 'device-a', action: 'download_fail', created_at: '2026-01-01T11:00:00Z' },
      { device_id: 'device-b', action: 'set', created_at: '2026-01-01T12:00:00Z' },
    ])

    expect(rows).toEqual([{ date: '2026-01-01', devices_failed: 1 }])
  })

  it.concurrent('does not count a device-day when set succeeds after fail the same day', () => {
    const rows = buildDailyDeviceUpdateOutcomesFromRows([
      { device_id: 'device-a', action: 'download_fail', created_at: '2026-01-01T10:00:00Z' },
      { device_id: 'device-a', action: 'set', created_at: '2026-01-01T11:00:00Z' },
    ])

    expect(rows).toEqual([])
  })

  it.concurrent('counts failure when fail follows set the same day', () => {
    const rows = buildDailyDeviceUpdateOutcomesFromRows([
      { device_id: 'device-a', action: 'set', created_at: '2026-01-01T10:00:00Z' },
      { device_id: 'device-a', action: 'download_fail', created_at: '2026-01-01T11:00:00Z' },
    ])

    expect(rows).toEqual([{ date: '2026-01-01', devices_failed: 1 }])
  })

  it.concurrent('returns separate daily results for the same device on different dates', () => {
    const rows = buildDailyDeviceUpdateOutcomesFromRows([
      { device_id: 'device-a', action: 'download_fail', created_at: '2026-01-01T10:00:00Z' },
      { device_id: 'device-a', action: 'download_fail', created_at: '2026-01-02T10:00:00Z' },
    ])

    expect(rows).toEqual([
      { date: '2026-01-01', devices_failed: 1 },
      { date: '2026-01-02', devices_failed: 1 },
    ])
  })
})
