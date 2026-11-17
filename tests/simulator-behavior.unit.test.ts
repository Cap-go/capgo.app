import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgState = vi.hoisted(() => ({
  queries: [] as string[],
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    pgState.queries.push(sql)
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK')
      return { rowCount: 0, rows: [] }
    if (sql.includes('DISTINCT owner_org'))
      return { rowCount: 0, rows: [] }
    if (sql.includes('bump_simulator_session_activity'))
      return { rowCount: 1, rows: [{ bumped: 1 }] }
    if (sql.includes('last_activity_at = $2'))
      return { rowCount: 1, rows: [{ last_activity_at: params?.[1] }] }
    if (sql.includes('SET status = $2'))
      return { rowCount: 1, rows: [{ id: params?.[0] }] }
    if (sql.includes('status = \'stopped\'') && sql.includes('device_stopped_at IS NULL'))
      return { rowCount: 1, rows: [{ id: '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4', emulator_id: 'emu-1', device_stopped_at: null }] }
    if (sql.includes('device_stopped_at = COALESCE'))
      return { rowCount: 1, rows: [{ device_stopped_at: params?.[1] }] }
    return { rowCount: 0, rows: [] }
  }),
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
const sessionId = '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4'
const liveRow = {
  id: sessionId,
  app_id: 'com.test.sim',
  platform: 'ios' as const,
  status: 'in-progress',
  url: 'https://host.test/s/x/',
  emulator_id: 'emu-1',
  started_at: new Date().toISOString(),
  last_activity_at: new Date().toISOString(),
  device_stopped_at: null,
  requested_by: '6aa76066-55ef-4238-ade6-0b32334a4097',
  max_duration_minutes: 40,
}

describe('simulator idle behavior', () => {
  beforeEach(() => {
    pgState.queries.length = 0
    pgState.query.mockClear()
    vi.unstubAllGlobals()
  })

  it('marks in-progress sessions with last_activity_at', async () => {
    const { markSession } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    await markSession(context, sessionId, 'in-progress', {
      url: 'https://host.test/s/x/',
      emulatorId: sessionId,
    })
    const update = pgState.queries.find(query => query.includes('UPDATE public.simulator_sessions'))
    expect(update).toContain('last_activity_at')
    expect(update).toContain('in-progress')
  })

  it('bumps activity through the shared SQL function', async () => {
    const { bumpSimulatorSessionActivity, simulatorActivityBumpSql } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    expect(simulatorActivityBumpSql()).toContain('bump_simulator_session_activity')
    await expect(bumpSimulatorSessionActivity(context, sessionId)).resolves.toBe(true)
    expect(pgState.queries.some(query => query.includes('bump_simulator_session_activity'))).toBe(true)
  })

  it('records command paths through the bump helper', async () => {
    const { touchSimulatorActivity } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    await touchSimulatorActivity(context, sessionId, {
      orgId: '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
      userId: liveRow.requested_by,
      appId: liveRow.app_id,
      row: liveRow,
    })
    expect(pgState.queries.some(query => query.includes('bump_simulator_session_activity'))).toBe(true)
  })

  it('bumps activity after wake and install hooks without session context', async () => {
    const { touchSimulatorActivity } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    await touchSimulatorActivity(context, sessionId)
    expect(pgState.queries.some(query => query.includes('bump_simulator_session_activity'))).toBe(true)
  })

  it('skips bumping activity on status reads', async () => {
    const { touchSimulatorActivity } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    await touchSimulatorActivity(context, sessionId, {
      orgId: '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
      userId: liveRow.requested_by,
      appId: liveRow.app_id,
      row: liveRow,
    }, { bump: false })
    expect(pgState.queries.some(query => query.includes('bump_simulator_session_activity'))).toBe(false)
  })

  it('syncs active rows from the host before the global sweep', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { status: 'stopped' } }), { status: 200 })))
    const simulator = await import('../supabase/functions/_backend/public/build/simulator.ts')
    const syncSpy = vi.spyOn(simulator, 'syncInProgressSimulatorSessionsFromHost').mockResolvedValue(2)
    const { sweepDueSimulatorSessions } = await import('../supabase/functions/_backend/public/build/concurrency.ts')
    await sweepDueSimulatorSessions(context)
    expect(syncSpy).toHaveBeenCalledTimes(1)
    syncSpy.mockRestore()
  })

  it('retries orphaned device stops', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = typeof url === 'string' ? url : url instanceof Request ? url.url : url.toString()
      if (target.includes('/stop') && init?.method === 'POST')
        return new Response(JSON.stringify({ data: { id: 'emu-1', status: 'stopped' } }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))
    const { stopOrphanedSimulatorDevices } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    await stopOrphanedSimulatorDevices(context)
    expect(pgState.queries.some(query => query.includes('device_stopped_at IS NULL'))).toBe(true)
    expect(vi.mocked(fetch)).toHaveBeenCalled()
  })

  it('pulls last activity from the host without using now()', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: {
        id: 'emu-1',
        url: 'https://host.test/s/emu-1/',
        status: 'in-progress',
        lastActivityAt: '2026-11-17T10:00:00.000Z',
      },
    }), { status: 200 })))
    const { syncSimulatorSessionFromHost } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    await syncSimulatorSessionFromHost(context, liveRow, {
      orgId: '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
      userId: liveRow.requested_by,
    })
    expect(pgState.queries.some(query => query.includes('last_activity_at = $2'))).toBe(true)
    expect(pgState.queries.some(query => query.includes('bump_simulator_session_activity'))).toBe(false)
  })
})