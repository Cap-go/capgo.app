import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const orgId = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
const sessionId = '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4'
const userId = '6aa76066-55ef-4238-ade6-0b32334a4097'
const appId = 'com.test.sim'
const freshHostActivity = '2026-11-17T10:09:00.000Z'
const staleDbActivity = '2026-11-17T10:00:00.000Z'

type PgQueryResult = { rowCount: number, rows: Record<string, unknown>[] }

const pgState = vi.hoisted(() => ({
  queries: [] as string[],
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
  platform: 'ios',
  status: 'in-progress',
  url: 'https://host.test/s/x/',
  emulator_id: 'emu-1',
  started_at: '2026-11-17T09:30:00.000Z',
  last_activity_at: staleDbActivity,
  device_stopped_at: null,
  requested_by: userId,
  max_duration_minutes: 40,
}

function stubFreshHostFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    data: {
      id: 'emu-1',
      url: 'https://host.test/s/x/',
      status: 'running',
      lastActivityAt: freshHostActivity,
    },
  }), { status: 200 })))
}

function installStaleIdlePgMock() {
  pgState.query.mockImplementation(async (sql: string, params?: unknown[]): Promise<PgQueryResult> => {
    pgState.queries.push(sql)
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK')
      return { rowCount: 0, rows: [] }
    if (sql.includes('owner_org = $1::uuid') && sql.includes('status = \'in-progress\'') && sql.includes('emulator_id IS NOT NULL'))
      return { rowCount: 1, rows: [{ ...liveRow }] }
    if (sql.includes('status = \'in-progress\'') && sql.includes('LIMIT') && sql.includes('emulator_id IS NOT NULL'))
      return { rowCount: 0, rows: [] }
    if (sql.includes('last_activity_at = $2'))
      return { rowCount: 1, rows: [{ last_activity_at: freshHostActivity }] }
    if (sql.includes('FOR UPDATE') && sql.includes('simulator_sessions'))
      return { rowCount: 0, rows: [] }
    if (sql.includes('expire_simulator_sessions'))
      return { rowCount: 1, rows: [{ expire_simulator_sessions: 0 }] }
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

async function expectHostRefreshWithoutDeviceStop(run: () => Promise<unknown>) {
  const simulator = await import('../supabase/functions/_backend/public/build/simulator.ts')
  const stopSpy = vi.spyOn(simulator, 'stopDevicesForDueSimulatorExpiry')
  await run()
  expect(stopSpy).not.toHaveBeenCalled()
  expect(pgState.queries.some(query => query.includes('last_activity_at = $2'))).toBe(true)
  stopSpy.mockRestore()
}

describe('simulator org expiry host sync', () => {
  beforeEach(() => {
    pgState.queries.length = 0
    pgState.query.mockReset()
    installStaleIdlePgMock()
    vi.unstubAllGlobals()
    stubFreshHostFetch()
  })

  it('refreshes stale idle timestamps from the host before the due query runs', async () => {
    const { expireSimulatorSessions } = await import('../supabase/functions/_backend/public/build/concurrency.ts')
    await expectHostRefreshWithoutDeviceStop(() => expireSimulatorSessions(context, orgId))
  })

  it('refreshes from the host before native build concurrency checks', async () => {
    const { assertNativeBuildConcurrencyAvailable } = await import('../supabase/functions/_backend/public/build/concurrency.ts')
    await expectHostRefreshWithoutDeviceStop(() => assertNativeBuildConcurrencyAvailable(context, {
      orgId,
      appId,
      userId,
    }))
  })

  it('refreshes from the host before a new simulator reservation', async () => {
    const { reserveSimulatorSlot } = await import('../supabase/functions/_backend/public/build/concurrency.ts')
    await expectHostRefreshWithoutDeviceStop(() => reserveSimulatorSlot(context, {
      orgId,
      appId,
      userId,
      platform: 'ios',
      name: 'Minute five',
    }))
  })

  it('refreshes from the host during the scheduled sweep org leg', async () => {
    const { sweepDueSimulatorSessions } = await import('../supabase/functions/_backend/public/build/concurrency.ts')
    await expectHostRefreshWithoutDeviceStop(() => sweepDueSimulatorSessions(context))
  })
})