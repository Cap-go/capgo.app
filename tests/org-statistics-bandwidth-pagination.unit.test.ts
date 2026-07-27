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

function createPagedRpcClient(pages: ReturnType<typeof makeMetric>[][]) {
  const rangeCalls: Array<[number, number]> = []

  return {
    rangeCalls,
    supabase: {
      rpc: vi.fn(() => {
        const builder: {
          order: ReturnType<typeof vi.fn>
          range: ReturnType<typeof vi.fn>
        } = {
          order: vi.fn(() => builder),
          range: vi.fn(async (from: number, to: number) => {
            rangeCalls.push([from, to])
            const pageIndex = Math.floor(from / statisticsTestUtils.APP_METRICS_PAGE_SIZE)
            return {
              data: pages[pageIndex] ?? [],
              error: null,
              status: 200,
            }
          }),
        }
        return builder
      }),
    } as any,
  }
}

describe('org statistics app metrics pagination', () => {
  it('pages past PostgREST max_rows so late app_ids are not dropped', async () => {
    const pageSize = statisticsTestUtils.APP_METRICS_PAGE_SIZE
    expect(pageSize).toBe(1000)

    const firstPage = Array.from({ length: pageSize }, (_, index) =>
      makeMetric(`com.early.app.${String(index).padStart(4, '0')}`, '2026-07-01'))
    const lateBandwidth = 7_340_032
    const secondPage = [
      makeMetric('com.zzz.busy.app', '2026-07-01', lateBandwidth),
      makeMetric('com.zzz.busy.app', '2026-07-02', lateBandwidth),
    ]
    const { supabase, rangeCalls } = createPagedRpcClient([firstPage, secondPage])

    const result = await statisticsTestUtils.fetchAppMetricsRows(fakeContext, supabase, {
      orgId: '11111111-1111-4111-8111-111111111111',
      startDate: '2026-07-01',
      endDate: '2026-07-30',
    })

    expect(result.error).toBeNull()
    expect(result.data).toHaveLength(pageSize + secondPage.length)
    expect(rangeCalls).toEqual([
      [0, pageSize - 1],
      [pageSize, pageSize * 2 - 1],
    ])
    expect(result.data?.some(row => row.app_id === 'com.zzz.busy.app' && row.bandwidth === lateBandwidth)).toBe(true)
  })

  it('maps metric dates to day indexes instead of array position', () => {
    const from = new Date('2026-07-01T00:00:00.000Z')
    expect(statisticsTestUtils.metricDayNumber('2026-07-01', from, 30)).toBe(0)
    expect(statisticsTestUtils.metricDayNumber('2026-07-15', from, 30)).toBe(14)
    expect(statisticsTestUtils.metricDayNumber('2026-06-30', from, 30)).toBeNull()
    expect(statisticsTestUtils.metricDayNumber('2026-07-31', from, 30)).toBeNull()
  })
})
