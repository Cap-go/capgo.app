import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SIMULATOR_ORG_HOST_SYNC_BUDGET_MS,
  SIMULATOR_ORG_HOST_SYNC_TIMEOUT_MS,
} from '../supabase/functions/_backend/public/build/simulator.ts'

const orgId = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
const sessionId = '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4'
const userId = '6aa76066-55ef-4238-ade6-0b32334a4097'
const appId = 'com.test.sim'
const freshHostActivity = '2026-11-17T10:09:00.000Z'
const staleDbActivity = '2026-11-17T10:00:00.000Z'

type PgQueryResult = { rowCount: number, rows: Record<string, unknown>[] }

const mockState = vi.hoisted(() => ({
  hostActivityRefreshed: false,
  hostReachable: true,
}))

const pgState = vi.hoisted(() => ({
  queries: [] as string[],
  queryParams: [] as unknown[][],
  query: vi.fn(async (_sql: string, _params?: unknown[]): Promise<PgQueryResult> => ({ rowCount: 0, rows: [] })),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/pg.ts')>(),
  getPgClient: vi.fn(async () => ({ query: pgState.query })),
  checkoutPgClient: vi.fn(async (pool: { query: typeof pgState.query }) => pool),
  releasePgClient: vi.fn(),
  closeClient: vi.fn(async () => {}),
  beginWriteTransaction: vi.fn(async (client: { query: typeof pgState.query }) => {
    await client.query('BEGIN')
  }),
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/utils.ts')>(),
  getEnv: (_c: unknown, key: string) => {
    if (key === 'SIMULATOR_ACCESS_KEY')
      return 'host-key'
    if (key === 'SIMULATOR_ORIGIN')
      return 'https://host.test'
    if (key === 'VITE_APP_URL')
      return 'https://console.capgo.app'
    return ''
  },
}))

const context = { get: () => undefined } as unknown as Context

const liveRow = {
  id: sessionId,
  owner_org: orgId,
  app_id: appId,
  platform: 'ios' as const,
  status: 'in-progress' as const,
  url: 'https://host.test/s/x/',
  emulator_id: 'emu-1',
  started_at: '2026-11-17T09:30:00.000Z',
  last_activity_at: staleDbActivity,
  device_stopped_at: null,
  requested_by: userId,
  max_duration_minutes: 40,
}

const dueDeviceRow = { id: sessionId, emulator_id: 'emu-1', device_stopped_at: null }

function mockExpireSimulatorSessions(sql: string, params?: unknown[]): PgQueryResult | null {
  if (!sql.includes('expire_simulator_sessions'))
    return null
  const skipIds = (params?.[1] as string[] | undefined) ?? []
  const wouldIdleExpire = !mockState.hostActivityRefreshed
  if (wouldIdleExpire && skipIds.includes(sessionId))
    return { rowCount: 1, rows: [{ expire_simulator_sessions: 0 }] }
  if (wouldIdleExpire)
    return { rowCount: 1, rows: [{ expire_simulator_sessions: 1 }] }
  return { rowCount: 1, rows: [{ expire_simulator_sessions: 0 }] }
}

function installStatefulPgMock() {
  mockState.hostActivityRefreshed = false
  pgState.query.mockImplementation(async (sql: string, params?: unknown[]): Promise<PgQueryResult> => {
    pgState.queries.push(sql)
    pgState.queryParams.push(params ?? [])
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK')
      return { rowCount: 0, rows: [] }
    if (sql.includes('owner_org = $1::uuid') && sql.includes('status = \'in-progress\'') && sql.includes('emulator_id IS NOT NULL'))
      return { rowCount: 1, rows: [{ ...liveRow }] }
    if (sql.includes('status = \'in-progress\'') && sql.includes('LIMIT') && sql.includes('emulator_id IS NOT NULL'))
      return { rowCount: 0, rows: [] }
    if (sql.includes('last_activity_at = $2')) {
      mockState.hostActivityRefreshed = true
      return { rowCount: 1, rows: [{ last_activity_at: freshHostActivity }] }
    }
    if (sql.includes('FOR UPDATE') && sql.includes('simulator_sessions')) {
      const skipIdleIds = (params?.[1] as string[] | undefined) ?? []
      if (skipIdleIds.includes(sessionId))
        return { rowCount: 0, rows: [] }
      if (!mockState.hostActivityRefreshed)
        return { rowCount: 1, rows: [dueDeviceRow] }
      return { rowCount: 0, rows: [] }
    }
    const expireResult = mockExpireSimulatorSessions(sql, params)
    if (expireResult)
      return expireResult
    if (sql.includes('DISTINCT owner_org'))
      return { rowCount: 1, rows: [{ owner_org: orgId }] }
    if (sql.includes('SELECT id FROM public.orgs'))
      return { rowCount: 1, rows: [{ id: orgId }] }
    if (sql.includes('native_build_concurrency') || sql.includes('current_plan'))
      return { rowCount: 1, rows: [{ native_build_concurrency: 2, plan_name: 'Maker' }] }
    if (sql.includes('AS active_count'))
      return { rowCount: 1, rows: [{ active_count: '0' }] }
    if (sql.includes('SELECT owner_org FROM public.apps'))
      return { rowCount: 1, rows: [{ owner_org: orgId }] }
    if (sql.includes('INSERT INTO public.simulator_sessions'))
      return { rowCount: 1, rows: [{ id: '8c2f1e40-3d61-40ac-9e55-2d907f4c33e6' }] }
    if (sql.includes('status = \'stopped\'') && sql.includes('device_stopped_at IS NULL'))
      return { rowCount: 0, rows: [] }
    return { rowCount: 0, rows: [] }
  })
}

function stubHostFetch(mode: 'fresh' | 'down' | '409') {
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (mode === 'down')
      throw new TypeError('host down')
    if (mode === '409')
      return new Response(JSON.stringify({ error: 'conflict' }), { status: 409 })
    return new Response(JSON.stringify({
      data: {
        id: 'emu-1',
        url: 'https://host.test/s/x/',
        status: 'running',
        lastActivityAt: freshHostActivity,
      },
    }), { status: 200 })
  }))
}

async function expectNoDeviceStopAfterHostRefresh(run: () => Promise<unknown>) {
  const simulator = await import('../supabase/functions/_backend/public/build/simulator.ts')
  const stopSpy = vi.spyOn(simulator, 'stopDevicesForDueSimulatorExpiry')
  await run()
  const refreshIdx = pgState.queries.findIndex(query => query.includes('last_activity_at = $2'))
  const dueIdx = pgState.queries.findIndex(query => query.includes('FOR UPDATE') && query.includes('simulator_sessions'))
  expect(refreshIdx).toBeGreaterThanOrEqual(0)
  expect(dueIdx).toBeGreaterThan(refreshIdx)
  expect(stopSpy).not.toHaveBeenCalled()
  stopSpy.mockRestore()
}

describe('simulator org expiry host sync', () => {
  beforeEach(() => {
    pgState.queries.length = 0
    pgState.queryParams.length = 0
    pgState.query.mockReset()
    mockState.hostReachable = true
    installStatefulPgMock()
    vi.unstubAllGlobals()
    stubHostFetch('fresh')
    vi.resetModules()
  })

  it('runs host refresh before the due query and skips device stop when idle clears', async () => {
    const { expireSimulatorSessions } = await import('../supabase/functions/_backend/public/build/concurrency.ts')
    await expectNoDeviceStopAfterHostRefresh(() => expireSimulatorSessions(context, orgId))
  })

  it('refreshes from the host before native build concurrency checks', async () => {
    const { assertNativeBuildConcurrencyAvailable } = await import('../supabase/functions/_backend/public/build/concurrency.ts')
    await expectNoDeviceStopAfterHostRefresh(() => assertNativeBuildConcurrencyAvailable(context, { orgId, appId, userId }))
  })

  it('refreshes from the host before a new simulator reservation', async () => {
    const { reserveSimulatorSlot } = await import('../supabase/functions/_backend/public/build/concurrency.ts')
    await expectNoDeviceStopAfterHostRefresh(() => reserveSimulatorSlot(context, {
      orgId,
      appId,
      userId,
      platform: 'ios',
      name: 'Minute five',
    }))
  })

  it('refreshes from the host during the scheduled sweep org leg', async () => {
    const { sweepDueSimulatorSessions } = await import('../supabase/functions/_backend/public/build/concurrency.ts')
    await expectNoDeviceStopAfterHostRefresh(() => sweepDueSimulatorSessions(context))
  })

  it('does not idle-expire when the host is down during a reservation', async () => {
    stubHostFetch('down')
    const simulator = await import('../supabase/functions/_backend/public/build/simulator.ts')
    const stopSpy = vi.spyOn(simulator, 'stopDevicesForDueSimulatorExpiry')
    const started = Date.now()
    const { reserveSimulatorSlot } = await import('../supabase/functions/_backend/public/build/concurrency.ts')
    await reserveSimulatorSlot(context, { orgId, appId, userId, platform: 'ios' })
    expect(Date.now() - started).toBeLessThan(SIMULATOR_ORG_HOST_SYNC_BUDGET_MS + 500)
    const dueParams = pgState.queryParams.find(params => (params?.[1] as string[] | undefined)?.includes(sessionId))
    expect(dueParams?.[1]).toContain(sessionId)
    const expireIndex = pgState.queries.findIndex(query => query.includes('expire_simulator_sessions'))
    expect(expireIndex).toBeGreaterThanOrEqual(0)
    expect(pgState.queryParams[expireIndex]).toEqual([orgId, [sessionId]])
    const expireRow = await Promise.resolve(mockExpireSimulatorSessions(
      pgState.queries[expireIndex]!,
      pgState.queryParams[expireIndex],
    ))
    expect(expireRow?.rows[0]?.expire_simulator_sessions).toBe(0)
    expect(stopSpy).not.toHaveBeenCalled()
    stopSpy.mockRestore()
  })

  it('finishes org reserve sync within the org wall-clock budget', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      await new Promise<void>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('slow host')), SIMULATOR_ORG_HOST_SYNC_TIMEOUT_MS + 5_000)
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new DOMException('The operation was aborted', 'AbortError'))
        })
      })
      return new Response('{}', { status: 200 })
    }))
    const started = Date.now()
    const { expireSimulatorSessions } = await import('../supabase/functions/_backend/public/build/concurrency.ts')
    await expireSimulatorSessions(context, orgId)
    expect(Date.now() - started).toBeLessThan(SIMULATOR_ORG_HOST_SYNC_BUDGET_MS + 1_500)
  })
})

describe('simulator host sync edge cases', () => {
  beforeEach(() => {
    pgState.queries.length = 0
    pgState.query.mockReset()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('keeps org sync going after one row fails', async () => {
    const firstId = '7b1e0d3f-2c50-4f9b-8d44-1c8f6e3b22d5'
    const secondId = '8c2f1e40-3d61-40ac-9e55-2d907f4c33e6'
    pgState.query.mockImplementation(async (sql: string, params?: unknown[]): Promise<PgQueryResult> => {
      pgState.queries.push(sql)
      if (sql.includes('owner_org = $1::uuid') && sql.includes('emulator_id IS NOT NULL'))
        return {
          rowCount: 2,
          rows: [
            { ...liveRow, id: firstId, emulator_id: 'emu-a' },
            { ...liveRow, id: secondId, emulator_id: 'emu-b' },
          ],
        }
      if (sql.includes('last_activity_at = $2') && params?.[0] === firstId)
        throw new Error('boom')
      if (sql.includes('last_activity_at = $2'))
        return { rowCount: 1, rows: [{ last_activity_at: freshHostActivity }] }
      return { rowCount: 0, rows: [] }
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: { id: 'emu-b', url: 'https://host.test/s/b/', status: 'running', lastActivityAt: freshHostActivity },
    }), { status: 200 })))
    const { syncInProgressSimulatorSessionsForOrgFromHost } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    const result = await syncInProgressSimulatorSessionsForOrgFromHost(context, orgId)
    expect(result.synced).toBe(1)
    expect(result.hostUnreachableSessionIds).toContain(firstId)
  })

  it('adds rows not reached to hostUnreachableSessionIds when the org budget expires', async () => {
    const pendingIds = [
      'a1000000-0000-4000-8000-000000000001',
      'a2000000-0000-4000-8000-000000000002',
      'a3000000-0000-4000-8000-000000000003',
      'a4000000-0000-4000-8000-000000000004',
      'a5000000-0000-4000-8000-000000000005',
      'a6000000-0000-4000-8000-000000000006',
    ]
    pgState.query.mockImplementation(async (sql: string): Promise<PgQueryResult> => {
      pgState.queries.push(sql)
      if (sql.includes('owner_org = $1::uuid') && sql.includes('emulator_id IS NOT NULL')) {
        return {
          rowCount: pendingIds.length,
          rows: pendingIds.map((id, index) => ({ ...liveRow, id, emulator_id: `emu-${index}` })),
        }
      }
      if (sql.includes('last_activity_at = $2'))
        return { rowCount: 1, rows: [{ last_activity_at: freshHostActivity }] }
      return { rowCount: 0, rows: [] }
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: { id: 'emu', url: 'https://host.test/s/x/', status: 'running', lastActivityAt: freshHostActivity },
    }), { status: 200 })))
    const budgetStart = Date.now()
    let nowCalls = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      nowCalls++
      if (nowCalls > 3)
        return budgetStart + SIMULATOR_ORG_HOST_SYNC_BUDGET_MS + 1
      return budgetStart
    })
    const { syncInProgressSimulatorSessionsForOrgFromHost } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    const result = await syncInProgressSimulatorSessionsForOrgFromHost(context, orgId)
    nowSpy.mockRestore()
    for (const id of pendingIds.slice(4))
      expect(result.hostUnreachableSessionIds).toContain(id)
    expect(result.synced).toBeLessThanOrEqual(4)
  })

  it('does not settle a session when host GET returns 409', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'conflict' }), { status: 409 })))
    pgState.query.mockImplementation(async (sql: string): Promise<PgQueryResult> => {
      pgState.queries.push(sql)
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK')
        return { rowCount: 0, rows: [] }
      return { rowCount: 0, rows: [] }
    })
    const { syncSimulatorSessionFromHost } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    const result = await syncSimulatorSessionFromHost(context, liveRow, { orgId, userId: liveRow.requested_by })
    expect(result).toBe('skipped')
    expect(pgState.queries.some(query => query.includes('device_stopped_at = COALESCE'))).toBe(false)
  })
})