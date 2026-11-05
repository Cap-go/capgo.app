import { describe, expect, it, vi } from 'vitest'
import { statisticsTestUtils } from '../supabase/functions/_backend/public/statistics/index.ts'

const fakeContext = {
  get: vi.fn(() => undefined),
} as any

function makeMetric(appId: string, date: string, bandwidth = 0) {
  return {
    app_id: appId,
    date,
    mau: 0,
    storage: 0,
    bandwidth,
    build_time_unit: 0,
    get: 0,
    fail: 0,
    install: 0,
    uninstall: 0,
  }
}

describe('org statistics app metrics', () => {
  it('reads every org metric row in one query instead of stopping at PostgREST max_rows', async () => {
    const firstApps = Array.from({ length: 1000 }, (_, index) =>
      makeMetric(`com.early.app.${String(index).padStart(4, '0')}`, '2026-07-01'))
    const lateBandwidth = 7_340_032
    const lateApp = [
      makeMetric('com.zzz.busy.app', '2026-07-01', lateBandwidth),
      makeMetric('com.zzz.busy.app', '2026-07-02', lateBandwidth),
    ]
    const db = vi.fn(async () => [...firstApps, ...lateApp])

    const result = await statisticsTestUtils.fetchAppMetricsRows(fakeContext, db as any, {
      orgId: '11111111-1111-4111-8111-111111111111',
      startDate: '2026-07-01',
      endDate: '2026-07-30',
    })

    expect(result.error).toBeNull()
    expect(result.data).toHaveLength(firstApps.length + lateApp.length)
    expect(db).toHaveBeenCalledTimes(1)
    const [sql, values] = db.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('public.get_app_metrics(org_id => $1::uuid')
    expect(sql).toContain('ORDER BY app_id ASC, date ASC')
    expect(sql).not.toContain('LIMIT')
    expect(values).toEqual(['11111111-1111-4111-8111-111111111111', '2026-07-01', '2026-07-30'])
    expect(result.data?.some(row => row.app_id === 'com.zzz.busy.app' && row.bandwidth === lateBandwidth)).toBe(true)
  })

  it('uses the single-app overload when an app id is given', async () => {
    const db = vi.fn(async () => [makeMetric('com.demo.app', '2026-07-01', 10)])

    const result = await statisticsTestUtils.fetchAppMetricsRows(fakeContext, db as any, {
      orgId: '11111111-1111-4111-8111-111111111111',
      appId: 'com.demo.app',
      startDate: '2026-07-01',
      endDate: '2026-07-30',
    })

    expect(result.data).toHaveLength(1)
    const [sql, values] = db.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('public.get_app_metrics(p_org_id => $1::uuid, p_app_id => $2::varchar')
    expect(values).toEqual(['11111111-1111-4111-8111-111111111111', 'com.demo.app', '2026-07-01', '2026-07-30'])
  })

  it('maps metric dates to day indexes instead of array position', () => {
    const from = new Date('2026-07-01T00:00:00.000Z')
    expect(statisticsTestUtils.metricDayNumber('2026-07-01', from, 30)).toBe(0)
    expect(statisticsTestUtils.metricDayNumber('2026-07-15', from, 30)).toBe(14)
    expect(statisticsTestUtils.metricDayNumber('2026-06-30', from, 30)).toBeNull()
    expect(statisticsTestUtils.metricDayNumber('2026-07-31', from, 30)).toBeNull()
  })
})
