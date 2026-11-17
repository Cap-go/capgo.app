import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgState = vi.hoisted(() => ({
  queries: [] as string[],
  queryParams: [] as unknown[][],
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    pgState.queries.push(sql)
    pgState.queryParams.push(params ?? [])
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK')
      return { rowCount: 0, rows: [] }
    if (sql.includes('DISTINCT owner_org'))
      return { rowCount: 0, rows: [] }
    if (sql.includes('expire_simulator_sessions'))
      return { rowCount: 1, rows: [{ expire_simulator_sessions: 0 }] }
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
    if (sql.includes('SET updated_at = now()') && sql.includes('WHERE id = $1'))
      return { rowCount: 1, rows: [] }
  }),
}))

const recordBuildTimeMock = vi.hoisted(() => vi.fn(async () => 'build-log-id'))

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

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  recordBuildTime: recordBuildTimeMock,
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
  started_at: '2026-11-17T09:00:00.000Z',
  last_activity_at: '2026-11-17T09:55:00.000Z',
  device_stopped_at: null,
  requested_by: '6aa76066-55ef-4238-ade6-0b32334a4097',
  max_duration_minutes: 40,
}

describe('simulator idle behavior', () => {
  beforeEach(() => {
    pgState.queries.length = 0
    pgState.queryParams.length = 0
    pgState.query.mockClear()
    recordBuildTimeMock.mockClear()
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
    const orphanSpy = vi.spyOn(simulator, 'stopOrphanedSimulatorDevices').mockResolvedValue(0)
    const { sweepDueSimulatorSessions } = await import('../supabase/functions/_backend/public/build/concurrency.ts')
    await sweepDueSimulatorSessions(context)
    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect(orphanSpy).toHaveBeenCalledTimes(1)
    syncSpy.mockRestore()
    orphanSpy.mockRestore()
  })

  it('bumps updated_at when an orphaned device stop keeps failing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed')
    }))
    const { stopOrphanedSimulatorDevices } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    await stopOrphanedSimulatorDevices(context)
    expect(pgState.queries.some(query => query.includes('device_stopped_at IS NULL'))).toBe(true)
    expect(pgState.queries.some(query => query.includes('SET updated_at = now()'))).toBe(true)
  })

  it('settles a host-stopped session using the host finishedAt', async () => {
    const hostFinishedAt = '2026-11-17T10:05:00.000Z'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: {
        id: 'emu-1',
        url: 'https://host.test/s/emu-1/',
        status: 'stopped',
        finishedAt: hostFinishedAt,
      },
    }), { status: 200 })))
    const { syncSimulatorSessionFromHost } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    const result = await syncSimulatorSessionFromHost(context, liveRow, {
      orgId: '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
      userId: liveRow.requested_by,
    })
    expect(result).toBe('finalized')
    const stopWrite = pgState.queries.find(query => query.includes('device_stopped_at = COALESCE'))
    expect(stopWrite).toBeDefined()
    const stopParams = pgState.queryParams[pgState.queries.indexOf(stopWrite!)]
    expect(stopParams?.[1]).toBe(hostFinishedAt)
    expect(recordBuildTimeMock).toHaveBeenCalled()
    expect(pgState.queries.some(query => query.includes('SET status = $2'))).toBe(true)
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