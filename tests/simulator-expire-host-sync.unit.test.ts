import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const orgId = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
const sessionId = '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4'
const userId = '6aa76066-55ef-4238-ade6-0b32334a4097'
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
    return ''
  },
}))

const context = { get: () => undefined } as unknown as Context

const liveRow = {
  id: sessionId,
  owner_org: orgId,
  app_id: 'com.test.sim',
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

describe('simulator org expiry host sync', () => {
  beforeEach(() => {
    pgState.queries.length = 0
    pgState.query.mockReset()
    pgState.query.mockImplementation(async (sql: string, params?: unknown[]): Promise<PgQueryResult> => {
      pgState.queries.push(sql)
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK')
        return { rowCount: 0, rows: [] }
      if (sql.includes('owner_org = $1::uuid') && sql.includes('status = \'in-progress\'') && sql.includes('emulator_id IS NOT NULL'))
        return { rowCount: 1, rows: [{ ...liveRow }] }
      if (sql.includes('last_activity_at = $2'))
        return { rowCount: 1, rows: [{ last_activity_at: freshHostActivity }] }
      if (sql.includes('FOR UPDATE') && sql.includes('simulator_sessions'))
        return { rowCount: 0, rows: [] }
      if (sql.includes('expire_simulator_sessions'))
        return { rowCount: 1, rows: [{ expire_simulator_sessions: 0 }] }
      return { rowCount: 0, rows: [] }
    })
    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: {
        id: 'emu-1',
        url: 'https://host.test/s/x/',
        status: 'running',
        lastActivityAt: freshHostActivity,
      },
    }), { status: 200 })))
  })

  it('refreshes stale idle timestamps from the host before the due query runs', async () => {
    const simulator = await import('../supabase/functions/_backend/public/build/simulator.ts')
    const stopSpy = vi.spyOn(simulator, 'stopDevicesForDueSimulatorExpiry')
    const { expireSimulatorSessions } = await import('../supabase/functions/_backend/public/build/concurrency.ts')
    await expireSimulatorSessions(context, orgId)
    expect(stopSpy).not.toHaveBeenCalled()
    expect(pgState.queries.some(query => query.includes('last_activity_at = $2'))).toBe(true)
    stopSpy.mockRestore()
  })
})