import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type PgQueryResult = { rowCount: number, rows: Record<string, unknown>[] }

async function defaultPgQuery(sql: string, params?: unknown[]): Promise<PgQueryResult> {
  pgState.queries.push(sql)
  pgState.queryParams.push(params ?? [])
  if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK')
    return { rowCount: 0, rows: [] }
  if (sql.includes('DISTINCT owner_org'))
    return { rowCount: 0, rows: [] }
  if (sql.includes('expire_simulator_sessions')) {
    const skipIds = (params?.[1] as string[] | undefined) ?? []
    if (skipIds.length > 0)
      return { rowCount: 1, rows: [{ expire_simulator_sessions: 0 }] }
    return { rowCount: 1, rows: [{ expire_simulator_sessions: 0 }] }
  }
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
  return { rowCount: 0, rows: [] }
}

const pgState = vi.hoisted(() => ({
  queries: [] as string[],
  queryParams: [] as unknown[][],
  query: vi.fn(defaultPgQuery),
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
const orgId = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
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
    pgState.query.mockReset()
    pgState.query.mockImplementation(defaultPgQuery)
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

  it('records confirmed session end as finished_at when stopping', async () => {
    const { markSession } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    const confirmedEnd = '2026-11-09T12:06:00.000Z'
    await markSession(context, sessionId, 'stopped', { finishedAt: confirmedEnd })
    const params = pgState.queryParams.find(entry => entry?.[1] === 'stopped')
    expect(params?.[4]).toBe(confirmedEnd)
    const update = pgState.queries.find(query => query.includes('finished_at = CASE'))
    expect(update).toContain('$5::timestamptz')
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

  const hostSyncFirstId = '7b1e0d3f-2c50-4f9b-8d44-1c8f6e3b22d5'
  const hostSyncSecondId = '8c2f1e40-3d61-40ac-9e55-2d907f4c33e6'

  function mockTwoInProgressRows() {
    pgState.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('status = \'in-progress\'') && sql.includes('LIMIT'))
        return {
          rowCount: 2,
          rows: [
            { ...liveRow, id: hostSyncFirstId, emulator_id: 'emu-a', url: 'https://host.test/s/a/', owner_org: orgId },
            { ...liveRow, id: hostSyncSecondId, emulator_id: 'emu-b', url: 'https://host.test/s/b/', owner_org: orgId },
          ],
        }
      if (sql.includes('last_activity_at = $2') && params?.[0] === hostSyncFirstId)
        throw new Error('boom')
      return defaultPgQuery(sql, params)
    })
  }

  function stubHostSyncFetch() {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const target = typeof url === 'string' ? url : url instanceof Request ? url.url : url.toString()
      if (target.includes('/v2/device-run-sessions/emu-b'))
        return new Response(JSON.stringify({
          data: {
            id: 'emu-b',
            url: 'https://host.test/s/b/',
            status: 'running',
            lastActivityAt: '2026-11-17T10:10:00.000Z',
          },
        }), { status: 200 })
      if (target.includes('/v2/device-run-sessions/emu-a'))
        return new Response(JSON.stringify({
          data: {
            id: 'emu-a',
            url: 'https://host.test/s/a/',
            status: 'running',
            lastActivityAt: '2026-11-17T10:09:00.000Z',
          },
        }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))
  }

  it('keeps host sync going after one row fails', async () => {
    mockTwoInProgressRows()
    stubHostSyncFetch()
    const { syncInProgressSimulatorSessionsFromHost } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    const synced = await syncInProgressSimulatorSessionsFromHost(context)
    expect(synced).toBe(1)
  })

  it('still expires orgs and stops orphans when one host sync row fails', async () => {
    pgState.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('status = \'in-progress\'') && sql.includes('LIMIT'))
        return {
          rowCount: 2,
          rows: [
            { ...liveRow, id: hostSyncFirstId, emulator_id: 'emu-a', owner_org: orgId },
            { ...liveRow, id: hostSyncSecondId, emulator_id: 'emu-b', owner_org: orgId },
          ],
        }
      if (sql.includes('last_activity_at = $2') && params?.[0] === hostSyncFirstId)
        throw new Error('boom')
      if (sql.includes('DISTINCT owner_org'))
        return { rowCount: 1, rows: [{ owner_org: orgId }] }
      if (sql.includes('FOR UPDATE') && sql.includes('simulator_sessions'))
        return { rowCount: 0, rows: [] }
      return defaultPgQuery(sql, params)
    })
    stubHostSyncFetch()
    const { sweepDueSimulatorSessions } = await import('../supabase/functions/_backend/public/build/concurrency.ts')
    const result = await sweepDueSimulatorSessions(context)
    expect(result.hostSync).toBe(1)
    expect(pgState.queries.some(query => query.includes('expire_simulator_sessions'))).toBe(true)
    expect(pgState.queries.some(query => query.includes('device_stopped_at IS NULL'))).toBe(true)
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

  it('refreshes lastActivityAt before settling a host-stopped session', async () => {
    const hostFinishedAt = '2026-11-17T10:05:00.000Z'
    const hostLastActivityAt = '2026-11-17T10:04:00.000Z'
    const staleRow = {
      ...liveRow,
      started_at: '2026-11-17T09:30:00.000Z',
      last_activity_at: '2026-11-17T09:55:00.000Z',
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: {
        id: 'emu-1',
        url: 'https://host.test/s/emu-1/',
        status: 'stopped',
        finishedAt: hostFinishedAt,
        lastActivityAt: hostLastActivityAt,
      },
    }), { status: 200 })))
    const { syncSimulatorSessionFromHost, simulatorBillingEndInstant } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    const result = await syncSimulatorSessionFromHost(context, staleRow, { orgId, userId: staleRow.requested_by })
    expect(result).toBe('finalized')
    const refreshIdx = pgState.queries.findIndex(query => query.includes('last_activity_at = $2'))
    const stopIdx = pgState.queries.findIndex(query => query.includes('device_stopped_at = COALESCE'))
    expect(refreshIdx).toBeGreaterThanOrEqual(0)
    expect(stopIdx).toBeGreaterThan(refreshIdx)
    const billEnd = simulatorBillingEndInstant(
      staleRow.started_at,
      hostLastActivityAt,
      Date.parse(hostFinishedAt),
    )
    expect(recordBuildTimeMock).toHaveBeenCalledWith(
      expect.anything(),
      orgId,
      staleRow.requested_by,
      staleRow.id,
      'ios',
      expect.any(Number),
      billEnd,
      staleRow.app_id,
    )
    const staleBillEnd = simulatorBillingEndInstant(
      staleRow.started_at,
      staleRow.last_activity_at,
      Date.parse(hostFinishedAt),
    )
    expect(billEnd).toBeGreaterThan(staleBillEnd)
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