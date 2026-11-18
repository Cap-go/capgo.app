import type { Context } from 'hono'
import type { RlsPrincipal } from '../supabase/functions/_backend/utils/pg_rls.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const orgId = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
const sessionId = '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4'
const userId = '6aa76066-55ef-4238-ade6-0b32334a4097'
const freshActivity = () => new Date(Date.now() - 60_000).toISOString()
const sessionStarted = () => new Date(Date.now() - 20 * 60_000).toISOString()

const pgState = vi.hoisted(() => ({
  queries: [] as string[],
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    pgState.queries.push(sql)
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK')
      return { rowCount: 0, rows: [] }
    if (sql.includes('last_activity_at = $2'))
      return { rowCount: 1, rows: [{ last_activity_at: params?.[1] ?? freshActivity() }] }
    if (sql.includes('bump_simulator_session_activity'))
      return { rowCount: 1, rows: [{ bumped: 1 }] }
    if (sql.includes('WHERE id = $1::uuid AND owner_org'))
      return {
        rowCount: 1,
        rows: [{
          id: sessionId,
          app_id: 'com.test.sim',
          platform: 'ios',
          status: 'in-progress',
          url: 'https://host.test/s/x/',
          emulator_id: 'emu-1',
          started_at: sessionStarted(),
          last_activity_at: freshActivity(),
          device_stopped_at: null,
          requested_by: userId,
          max_duration_minutes: 40,
        }],
      }
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

const context = {
  get: () => undefined,
  json: (body: unknown) => new Response(JSON.stringify(body), { status: 200 }),
} as unknown as Context
const principal = {} as RlsPrincipal

describe('simulator entrypoint activity bumps', () => {
  beforeEach(() => {
    pgState.queries.length = 0
    pgState.query.mockClear()
    vi.unstubAllGlobals()
  })

  it('bumps activity when a console command runs', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const target = typeof url === 'string' ? url : url instanceof Request ? url.url : url.toString()
      if (target.includes('/v2/device-run-sessions/'))
        return new Response(JSON.stringify({ data: { status: 'running', lastActivityAt: freshActivity() } }), { status: 200 })
      return new Response(JSON.stringify({ result: { data: null } }), { status: 200 })
    }))
    const { commandSimulator } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    await commandSimulator(context, sessionId, { app_id: 'com.test.sim', command: 'home' }, userId, principal)
    expect(pgState.queries.some(query => query.includes('bump_simulator_session_activity'))).toBe(true)
  })

  it('accepts commands when the database looks idle but the host is still running', async () => {
    const freshActivity = new Date(Date.now() - 60_000).toISOString()
    const staleActivity = new Date(Date.now() - 10 * 60_000).toISOString()
    pgState.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      pgState.queries.push(sql)
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK')
        return { rowCount: 0, rows: [] }
      if (sql.includes('last_activity_at = $2'))
        return { rowCount: 1, rows: [{ last_activity_at: freshActivity }] }
      if (sql.includes('bump_simulator_session_activity'))
        return { rowCount: 1, rows: [{ bumped: 1 }] }
      if (sql.includes('WHERE id = $1::uuid AND owner_org'))
        return {
          rowCount: 1,
          rows: [{
            id: sessionId,
            app_id: 'com.test.sim',
            platform: 'ios',
            status: 'in-progress',
            url: 'https://host.test/s/x/',
            emulator_id: 'emu-1',
            started_at: new Date(Date.now() - 20 * 60_000).toISOString(),
            last_activity_at: staleActivity,
            device_stopped_at: null,
            requested_by: userId,
            max_duration_minutes: 40,
          }],
        }
      return { rowCount: 0, rows: [] }
    })
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const target = typeof url === 'string' ? url : url instanceof Request ? url.url : url.toString()
      if (target.includes('/v2/device-run-sessions/'))
        return new Response(JSON.stringify({ data: { status: 'running', lastActivityAt: freshActivity } }), { status: 200 })
      return new Response(JSON.stringify({ result: { data: null } }), { status: 200 })
    }))
    const { commandSimulator } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    await expect(commandSimulator(context, sessionId, { app_id: 'com.test.sim', command: 'home' }, userId, principal)).resolves.toBeTruthy()
    expect(pgState.queries.some(query => query.includes('bump_simulator_session_activity'))).toBe(true)
    expect(pgState.queries.some(query => query.includes('SET status = $2'))).toBe(false)
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
            lastActivityAt: '2026-11-17T10:09:00.000Z',
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