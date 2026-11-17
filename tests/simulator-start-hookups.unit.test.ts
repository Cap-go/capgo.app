import type { Context } from 'hono'
import type { RlsPrincipal } from '../supabase/functions/_backend/utils/pg_rls.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const orgId = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
const sessionId = '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4'
const userId = '6aa76066-55ef-4238-ade6-0b32334a4097'

const pgState = vi.hoisted(() => ({
  queries: [] as string[],
  query: vi.fn(async (sql: string, _params?: unknown[]) => {
    pgState.queries.push(sql)
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK')
      return { rowCount: 0, rows: [] }
    if (sql.includes('bump_simulator_session_activity'))
      return { rowCount: 1, rows: [{ bumped: 1 }] }
    if (sql.includes('SET status = $2'))
      return { rowCount: 1, rows: [{ id: sessionId }] }
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
  backgroundTask: vi.fn(async (_c: unknown, task: Promise<unknown>) => {
    await task
  }),
}))

vi.mock('../supabase/functions/_backend/public/build/request.ts', () => ({
  ensureBuildPermission: vi.fn(async () => {}),
  getBuildOwnerOrg: vi.fn(async () => orgId),
  ensureBuildTimePlanAllowed: vi.fn(async () => {}),
}))

vi.mock('../supabase/functions/_backend/public/build/concurrency.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/public/build/concurrency.ts')>(),
  reserveSimulatorSlot: vi.fn(async () => ({
    id: sessionId,
    activeBuilds: 0,
    limit: 2,
    planName: 'Solo',
    upgradeUrl: 'https://console.capgo.app/settings/organization/plans',
  })),
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

describe('simulator start hookups', () => {
  beforeEach(() => {
    pgState.queries.length = 0
    pgState.query.mockClear()
    vi.unstubAllGlobals()
  })

  it('wires the ios wake bump through startSimulator', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = typeof url === 'string' ? url : url instanceof Request ? url.url : url.toString()
      if (target.includes('/v2/device-run-sessions') && init?.method === 'POST')
        return new Response(JSON.stringify({ data: { id: sessionId, url: 'https://host.test/s/x/' } }), { status: 200 })
      if (target.includes('api/status'))
        return new Response('{}', { status: 200 })
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { startSimulator } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    await startSimulator(context, { app_id: 'com.test.sim', platform: 'ios' }, userId, principal)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('api/status'))).toBe(true)
    expect(pgState.queries.some(query => query.includes('bump_simulator_session_activity'))).toBe(true)
  })

  it('wires saved build install and bump through startSimulator', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = typeof url === 'string' ? url : url instanceof Request ? url.url : url.toString()
      if (target.includes('/v2/device-run-sessions') && init?.method === 'POST')
        return new Response(JSON.stringify({ data: { id: sessionId, url: 'https://host.test/s/x/' } }), { status: 200 })
      if (target.includes('api/status'))
        return new Response('{}', { status: 200 })
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
    })
    vi.stubGlobal('fetch', fetchMock)
    const { startSimulator } = await import('../supabase/functions/_backend/public/build/simulator.ts')
    await startSimulator(context, {
      app_id: 'com.test.sim',
      platform: 'ios',
      build_job_id: 'job-ios-1',
    }, userId, principal)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('api/install'))).toBe(true)
    expect(pgState.queries.some(query => query.includes('bump_simulator_session_activity'))).toBe(true)
  })
})