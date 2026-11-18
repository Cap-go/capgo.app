import type { Context } from 'hono'
import type { RlsPrincipal } from '../supabase/functions/_backend/utils/pg_rls.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const orgId = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
const sessionId = '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4'
const userId = '6aa76066-55ef-4238-ade6-0b32334a4097'
const sessionStarted = () => new Date(Date.now() - 20 * 60_000).toISOString()
const IDLE_MS = 5 * 60_000

function bumpWouldSucceed(lastActivityAt: string, startedAt: string, maxDurationMinutes: number): boolean {
  const now = Date.now()
  const startedMs = new Date(startedAt).getTime()
  const activityMs = new Date(lastActivityAt).getTime()
  if (Number.isNaN(startedMs) || Number.isNaN(activityMs))
    return false
  if (startedMs <= now - maxDurationMinutes * 60_000)
    return false
  if (activityMs <= now - IDLE_MS)
    return false
  return true
}

const sessionState = vi.hoisted(() => ({
  started_at: new Date(Date.now() - 20 * 60_000).toISOString(),
  last_activity_at: new Date(Date.now() - 60_000).toISOString(),
  status: 'in-progress' as 'in-progress' | 'stopped',
  max_duration_minutes: 40,
}))

const pgState = vi.hoisted(() => ({
  queries: [] as string[],
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    pgState.queries.push(sql)
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK')
      return { rowCount: 0, rows: [] }
    if (sql.includes('last_activity_at = $2')) {
      sessionState.last_activity_at = String(params?.[1] ?? sessionState.last_activity_at)
      return { rowCount: 1, rows: [{ last_activity_at: sessionState.last_activity_at }] }
    }
    if (sql.includes('bump_simulator_session_activity')) {
      const bumped = bumpWouldSucceed(sessionState.last_activity_at, sessionState.started_at, sessionState.max_duration_minutes) ? 1 : 0
      return { rowCount: 1, rows: [{ bumped }] }
    }
    if (sql.includes('FROM public.simulator_sessions') && sql.includes('owner_org = $2'))
      return {
        rowCount: 1,
        rows: [{
          id: sessionId,
          app_id: 'com.test.sim',
          platform: 'ios',
          status: sessionState.status,
          url: 'https://host.test/s/x/',
          emulator_id: 'emu-1',
          started_at: sessionState.started_at,
          last_activity_at: sessionState.last_activity_at,
          device_stopped_at: null,
          requested_by: userId,
          max_duration_minutes: sessionState.max_duration_minutes,
        }],
      }
    if (sql.includes('UPDATE public.simulator_sessions') && sql.includes('finished_at = CASE'))
      if (params?.[1] === 'stopped' || params?.[1] === 'errored')
        sessionState.status = 'stopped'
      return { rowCount: 1, rows: [{ id: sessionId }] }
    if (sql.includes('device_stopped_at = COALESCE'))
      return { rowCount: 1, rows: [{ device_stopped_at: params?.[1] }] }
    if (sql.includes('SET updated_at = now()') && !sql.includes('device_stopped_at'))
      return { rowCount: 1, rows: [] }
    if (sql.includes('SET status = $2'))
      return { rowCount: 1, rows: [{ id: params?.[0] }] }
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

vi.mock('../supabase/functions/_backend/public/build/request.ts', () => ({
  ensureBuildPermission: vi.fn(async () => {}),
  getBuildOwnerOrg: vi.fn(async () => orgId),
  ensureBuildTimePlanAllowed: vi.fn(async () => {}),
}))

vi.mock('../supabase/functions/_backend/public/build/outputs.ts', () => ({
  savedOutputsForJobs: vi.fn(async () => ({
    'job-ios-1': { kind: 'ios_ipa', url: 'https://cdn.example.test/app.ipa' },
  })),
}))

const recordBuildTimeMock = vi.hoisted(() => vi.fn(async () => 'build-log-id'))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  recordBuildTime: recordBuildTimeMock,
}))

const context = {
  get: () => undefined,
  json: (body: unknown) => new Response(JSON.stringify(body), { status: 200 }),
} as unknown as Context
const principal = {} as RlsPrincipal

describe('simulator entrypoint activity bumps', () => {
  beforeEach(() => {
    pgState.queries.length = 0
    pgState.query.mockClear()
    sessionState.started_at = sessionStarted()
    sessionState.last_activity_at = new Date(Date.now() - 60_000).toISOString()
    sessionState.status = 'in-progress'
    vi.unstubAllGlobals()
  })

  it('bumps activity when a console command runs', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const target = typeof url === 'string' ? url : url instanceof Request ? url.url : url.toString()
      if (target.includes('/v2/device-run-sessions/'))
        return new Response(JSON.stringify({ data: { status: 'running', lastActivityAt: sessionState.last_activity_at } }), { status: 200 })
      return new Response(JSON.stringify({ result: { data: null } }), { status: 200 })
    }))
    const { commandSimulator } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    await commandSimulator(context, sessionId, { app_id: 'com.test.sim', command: 'home' }, userId, principal)
    expect(pgState.queries.some(query => query.includes('bump_simulator_session_activity'))).toBe(true)
  })

  it('accepts commands when the database looks idle but the host is still running', async () => {
    const freshActivity = new Date(Date.now() - 60_000).toISOString()
    const staleActivity = new Date(Date.now() - 10 * 60_000).toISOString()
    sessionState.last_activity_at = staleActivity
    expect(bumpWouldSucceed(staleActivity, sessionState.started_at, sessionState.max_duration_minutes)).toBe(false)
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = typeof url === 'string' ? url : url instanceof Request ? url.url : url.toString()
      if (target.includes('/v2/device-run-sessions/'))
        return new Response(JSON.stringify({ data: { status: 'running', lastActivityAt: freshActivity } }), { status: 200 })
      return new Response(JSON.stringify({ result: { data: null } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { commandSimulator } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    await expect(commandSimulator(context, sessionId, { app_id: 'com.test.sim', command: 'home' }, userId, principal)).resolves.toBeTruthy()
    expect(sessionState.last_activity_at).toBe(freshActivity)
    expect(bumpWouldSucceed(sessionState.last_activity_at, sessionState.started_at, sessionState.max_duration_minutes)).toBe(true)
    expect(fetchMock).toHaveBeenCalled()
    expect(pgState.queries.some(query => query.includes('last_activity_at = $2'))).toBe(true)
    const bumpIndex = pgState.queries.findIndex(query => query.includes('bump_simulator_session_activity'))
    const refreshIndex = pgState.queries.findIndex(query => query.includes('last_activity_at = $2'))
    expect(bumpIndex).toBeGreaterThan(refreshIndex)
    expect(pgState.queries.some(query => query.includes('bump_simulator_session_activity'))).toBe(true)
    expect(pgState.queries.some(query => query.includes('SET status = $2'))).toBe(false)
    expect(fetchMock.mock.calls.some(([url]) => {
      const target = typeof url === 'string' ? url : url instanceof Request ? url.url : url.toString()
      return target.includes('agent-device/rpc')
    })).toBe(true)
  })

  it('rejects commands when the activity bump write fails', async () => {
    const priorQuery = pgState.query.getMockImplementation()
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = typeof url === 'string' ? url : url instanceof Request ? url.url : url.toString()
      if (target.includes('/v2/device-run-sessions/') && (!init || init.method === 'GET'))
        return new Response(JSON.stringify({ data: { status: 'running', lastActivityAt: sessionState.last_activity_at } }), { status: 200 })
      return new Response(JSON.stringify({ result: { data: null } }), { status: 200 })
    }))
    pgState.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('bump_simulator_session_activity'))
        throw new Error('db write failed')
      return priorQuery!(sql, params)
    })
    try {
      const { commandSimulator, SIMULATOR_STOPPED_MESSAGE } = await import('../supabase/functions/_backend/public/build/simulator.ts')
      await expect(
        commandSimulator(context, sessionId, { app_id: 'com.test.sim', command: 'home' }, userId, principal),
      ).rejects.toMatchObject({ message: expect.stringContaining(SIMULATOR_STOPPED_MESSAGE.slice(0, 20)) })
      expect(pgState.queries.filter(query => query.includes('agent-device/rpc')).length).toBe(0)
    }
    finally {
      pgState.query.mockImplementation(priorQuery!)
    }
  })

  it('rejects commands when the bump guard shows the session is no longer eligible', async () => {
    sessionState.started_at = new Date(Date.now() - 45 * 60_000).toISOString()
    sessionState.last_activity_at = new Date(Date.now() - 10 * 60_000).toISOString()
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = typeof url === 'string' ? url : url instanceof Request ? url.url : url.toString()
      if (target.includes('/v2/device-run-sessions/') && (!init || init.method === 'GET'))
        return new Response(JSON.stringify({ data: { status: 'running', lastActivityAt: sessionState.last_activity_at } }), { status: 200 })
      return new Response(JSON.stringify({ result: { data: null } }), { status: 200 })
    }))
    const { commandSimulator, SIMULATOR_STOPPED_MESSAGE } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    await expect(
      commandSimulator(context, sessionId, { app_id: 'com.test.sim', command: 'home' }, userId, principal),
    ).rejects.toMatchObject({ message: expect.stringContaining(SIMULATOR_STOPPED_MESSAGE.slice(0, 20)) })
    expect(pgState.queries.filter(query => query.includes('agent-device/rpc')).length).toBe(0)
  })

  it('rejects commands when the host session is already stopped', async () => {
    recordBuildTimeMock.mockResolvedValueOnce(null as unknown as string)
    const stoppedAt = new Date(Date.now() - 2 * 60_000).toISOString()
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = typeof url === 'string' ? url : url instanceof Request ? url.url : url.toString()
      if (target.includes('/v2/device-run-sessions/emu-1') && (!init || init.method === 'GET'))
        return new Response(JSON.stringify({ data: { status: 'stopped', finishedAt: stoppedAt, lastActivityAt: stoppedAt } }), { status: 200 })
      if (target.includes('/stop'))
        return new Response(JSON.stringify({ data: { status: 'stopped' } }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))
    const { commandSimulator, SIMULATOR_STOPPED_MESSAGE } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    await expect(
      commandSimulator(context, sessionId, { app_id: 'com.test.sim', command: 'home' }, userId, principal),
    ).rejects.toMatchObject({ message: expect.stringContaining(SIMULATOR_STOPPED_MESSAGE.slice(0, 20)) })
    expect(sessionState.status).toBe('in-progress')
    expect(pgState.queries.some(query => query.includes('bump_simulator_session_activity'))).toBe(false)
    expect(pgState.queries.filter(query => query.includes('agent-device/rpc')).length).toBe(0)
  })

  it('bumps activity after a saved build install', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = typeof url === 'string' ? url : url instanceof Request ? url.url : url.toString()
      if (target.includes('app.ipa'))
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]))
            controller.close()
          },
        }), { status: 200, headers: { 'content-length': '3' } })
      if (target.includes('api/install'))
        return new Response('ok', { status: 200 })
      return new Response('{}', { status: 404 })
    }))
    const { installSavedIpa } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    await installSavedIpa(
      context,
      principal,
      'com.test.sim',
      orgId,
      'job-ios-1',
      'https://host.test/s/x/',
      'host-key',
      sessionId,
    )
    expect(pgState.queries.some(query => query.includes('bump_simulator_session_activity'))).toBe(true)
  })

  it('does not bump activity on readSimulator status polls', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const target = typeof url === 'string' ? url : url instanceof Request ? url.url : url.toString()
      if (target.includes('/v2/device-run-sessions/'))
        return new Response(JSON.stringify({
          data: {
            id: 'emu-1',
            url: 'https://host.test/s/x/',
            status: 'running',
            lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
          },
        }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))
    const { readSimulator } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    const response = await readSimulator(context, sessionId, { app_id: 'com.test.sim' }, userId, principal)
    expect(response.status).toBe(200)
    expect(pgState.queries.some(query => query.includes('bump_simulator_session_activity'))).toBe(false)
  })

  it('bumps activity after the post-start wake path', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const target = typeof url === 'string' ? url : url instanceof Request ? url.url : url.toString()
      if (target.includes('api/status'))
        return new Response('{}', { status: 200 })
      return new Response('{}', { status: 404 })
    }))
    const { wakeSimulatorAndRecordActivity } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    await wakeSimulatorAndRecordActivity(context, sessionId, 'https://host.test/s/x/', 'host-key')
    expect(pgState.queries.some(query => query.includes('bump_simulator_session_activity'))).toBe(true)
  })
})