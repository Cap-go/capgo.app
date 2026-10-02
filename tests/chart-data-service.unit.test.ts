import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invokeCapgoApi: vi.fn(),
}))

vi.mock('~/services/capgoApi', () => ({
  invokeCapgoApi: mocks.invokeCapgoApi,
}))

const { clearChartDataCache, useChartData } = await import('../src/services/chartDataService')

const supabase = {
  auth: {
    getClaims: vi.fn(async () => ({ data: { claims: { session_id: 'session-1' } } })),
  },
} as unknown as SupabaseClient

const from = new Date('2026-09-01T00:00:00.000Z')
const to = new Date('2026-09-03T00:00:00.000Z')

describe('useChartData', () => {
  beforeEach(() => {
    clearChartDataCache()
    mocks.invokeCapgoApi.mockReset()
  })

  it('shares one in-flight request between concurrent callers of the same range', async () => {
    let resolveRequest!: (value: unknown) => void
    mocks.invokeCapgoApi.mockReturnValue(new Promise((resolve) => {
      resolveRequest = resolve
    }))

    const forced = useChartData(supabase, 'com.example.app', from, to, 'native', { forceRefetch: true })
    const cached = useChartData(supabase, 'com.example.app', from, to, 'native')
    await vi.waitFor(() => expect(mocks.invokeCapgoApi).toHaveBeenCalledTimes(1))

    resolveRequest({ error: null, data: { labels: ['2026-09-01'], datasets: [{ label: 'iOS 1.0.0', data: [100], metaCounts: [4] }] } })
    const [first, second] = await Promise.all([forced, cached])

    expect(mocks.invokeCapgoApi).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)
    expect(first.datasets[0].metaCountValues).toEqual([4])
  })

  it('issues a new request once the previous one has settled and refetch is forced', async () => {
    mocks.invokeCapgoApi.mockResolvedValue({ error: null, data: { labels: [], datasets: [] } })

    await useChartData(supabase, 'com.example.app', from, to, 'native')
    await useChartData(supabase, 'com.example.app', from, to, 'native', { forceRefetch: true })

    expect(mocks.invokeCapgoApi).toHaveBeenCalledTimes(2)
  })
})
