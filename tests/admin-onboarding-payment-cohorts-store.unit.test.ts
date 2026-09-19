import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAdminDashboardStore } from '../src/stores/adminDashboard'

const main = vi.hoisted(() => ({ isAdmin: true, authGeneration: 1, user: { id: 'fake-platform-admin' } }))
const session = vi.hoisted(() => vi.fn())
vi.mock('~/stores/main', () => ({ useMainStore: () => main }))
vi.mock('~/services/supabase', () => ({
  defaultApiHost: 'https://api.example.test',
  useSupabase: () => ({ auth: { getSession: session } }),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function response(value: unknown) {
  return new Response(JSON.stringify({ success: true, data: value }), { status: 200 })
}

const category = 'onboarding_payment_cohorts' as Parameters<ReturnType<typeof useAdminDashboardStore>['fetchStats']>[0]
let network: ReturnType<typeof vi.fn<typeof fetch>>

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-16T22:40:00.000Z'))
  main.isAdmin = true
  main.authGeneration = 1
  main.user = { id: 'fake-platform-admin' }
  session.mockResolvedValue({ data: { session: { access_token: 'fake-token' } } })
  network = vi.fn<typeof fetch>().mockImplementation(async () => response({ marker: 'current' }))
  vi.stubGlobal('fetch', network)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('payment cohort UTC-day store requests', () => {
  it('requests the rolling four UTC months without chart filters', async () => {
    const store = useAdminDashboardStore()
    store.setOrgFilter('fake-org')
    store.setAppFilter('com.example.fake')
    store.setCustomDateRange(new Date('2024-01-01Z'), new Date('2024-01-02Z'))
    await store.fetchStats(category)
    expect(JSON.parse(String(network.mock.calls[0][1]?.body))).toEqual({
      metric_category: category,
      start_date: '2026-06-01T00:00:00.000Z',
      end_date: '2026-09-16T00:00:00.000Z',
    })
  })

  it('reuses a same-day cached report despite every chart filter changing', async () => {
    const store = useAdminDashboardStore()
    const first = await store.fetchStats(category)
    store.setOrgFilter('other-fake-org')
    store.setAppFilter('com.example.other')
    store.setDateRangeMode('7day')
    vi.setSystemTime(new Date('2026-09-16T22:42:00.000Z'))
    expect(await store.fetchStats(category)).toEqual(first)
    expect(network).toHaveBeenCalledTimes(1)
  })

  it('rolls the UTC day and month even while the previous cache is within its TTL', async () => {
    vi.setSystemTime(new Date('2026-09-30T23:59:00.000Z'))
    const store = useAdminDashboardStore()
    await store.fetchStats(category)
    vi.setSystemTime(new Date('2026-10-01T00:01:00.000Z'))
    await store.fetchStats(category)
    expect(network).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(network.mock.calls[1][1]?.body))).toEqual({
      metric_category: category,
      start_date: '2026-07-01T00:00:00.000Z',
      end_date: '2026-10-01T00:00:00.000Z',
    })
  })

  it('does not let an older concurrent request replace a forced refresh in the cache', async () => {
    const older = deferred<Response>()
    const newer = deferred<Response>()
    network.mockReset().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const store = useAdminDashboardStore()
    const first = store.fetchStats(category)
    const second = store.fetchStats(category, true)
    expect(store.isLoading).toBe(true)
    newer.resolve(response({ marker: 'newer' }))
    expect(await second).toEqual({ marker: 'newer' })
    expect(store.isLoading).toBe(true)
    older.resolve(response({ marker: 'older' }))
    await first
    expect(store.isLoading).toBe(false)
    expect(await store.fetchStats(category)).toEqual({ marker: 'newer' })
    expect(network).toHaveBeenCalledTimes(2)
  })

  it('invalidates pending cache writes on global refresh', async () => {
    const pending = deferred<Response>()
    network.mockReset().mockReturnValueOnce(pending.promise).mockResolvedValue(response({ marker: 'fresh' }))
    const store = useAdminDashboardStore()
    const first = store.fetchStats(category)
    store.invalidateCache()
    pending.resolve(response({ marker: 'before-refresh' }))
    await first
    expect(await store.fetchStats(category)).toEqual({ marker: 'fresh' })
    expect(network).toHaveBeenCalledTimes(2)
  })

  it('denies non-platform-admin requests even if a report is cached', async () => {
    const store = useAdminDashboardStore()
    await store.fetchStats(category)
    main.isAdmin = false
    await expect(store.fetchStats(category)).rejects.toThrow()
    expect(network).toHaveBeenCalledTimes(1)
  })

  it('does not share a cached report across auth identities', async () => {
    const store = useAdminDashboardStore()
    await store.fetchStats(category)
    main.authGeneration++
    main.user = { id: 'other-fake-platform-admin' }
    await store.fetchStats(category)
    expect(network).toHaveBeenCalledTimes(2)
  })

  it('does not let a pre-reset request clear the loading flag of the new request', async () => {
    const old = deferred<Response>()
    const fresh = deferred<Response>()
    network.mockReset().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const store = useAdminDashboardStore()
    const first = store.fetchStats(category)
    store.$reset()
    const second = store.fetchStats(category)
    old.resolve(response({ marker: 'before-reset' }))
    await first
    expect(store.isLoading).toBe(true)
    fresh.resolve(response({ marker: 'after-reset' }))
    await second
    expect(store.isLoading).toBe(false)
  })

  it('rejects a request when platform-admin auth changes before the response', async () => {
    const pending = deferred<Response>()
    network.mockReturnValueOnce(pending.promise)
    const store = useAdminDashboardStore()
    const first = store.fetchStats(category)
    await Promise.resolve()
    expect(network).toHaveBeenCalledTimes(1)
    main.authGeneration++
    pending.resolve(response({ marker: 'obsolete-auth' }))
    await expect(first).rejects.toThrow('session changed')
    expect(store.isLoading).toBe(false)
    await store.fetchStats(category)
    expect(network).toHaveBeenCalledTimes(2)
  })

  it('retains the existing filter body and cache behavior for other categories', async () => {
    const store = useAdminDashboardStore()
    store.setOrgFilter('fake-org')
    store.setAppFilter('com.example.fake')
    await store.fetchStats('frontend_onboarding_analytics')
    const body = JSON.parse(String(network.mock.calls[0][1]?.body))
    expect(body.org_id).toBe('fake-org')
    expect(body.app_id).toBe('com.example.fake')
    await store.fetchStats('frontend_onboarding_analytics')
    expect(network).toHaveBeenCalledTimes(1)
  })
})
