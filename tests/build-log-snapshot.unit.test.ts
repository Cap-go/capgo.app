import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onError } from '../supabase/functions/_backend/utils/on_error.ts'
import { streamBuildLogs } from '../supabase/functions/_backend/public/build/logs.ts'

const mocks = vi.hoisted(() => ({ query: vi.fn(), permission: vi.fn(), token: vi.fn(), fetch: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  apikeyPrincipal: vi.fn(), withRlsContext: async (_c: unknown, _principal: unknown, fn: (client: unknown) => unknown) => fn({}), queryJson: (...args: unknown[]) => mocks.query(...args),
}))
vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({ checkPermission: (...args: unknown[]) => mocks.permission(...args) }))
vi.mock('../supabase/functions/_backend/utils/discord.ts', () => ({ sendDiscordAlert500: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({ capturePosthogException: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({ backgroundTask: vi.fn(), getEnv: (_c: unknown, key: string) => ({ BUILDER_URL: 'https://builder.example.com', BUILDER_API_KEY: 'fake-key', JWT_SECRET: 'fake-secret' })[key] }))
vi.mock('../supabase/functions/_backend/public/build/start.ts', () => ({ generateLogStreamToken: (...args: unknown[]) => mocks.token(...args) }))

const app = new Hono()
app.onError(onError('build'))
app.get('/', c => streamBuildLogs(c, 'example-cloud-job', 'com.example.app', { key: 'example-test-key', user_id: 'example-user' }, true))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.query.mockResolvedValue([{ app_id: 'com.example.app' }])
  mocks.permission.mockResolvedValue(true)
  mocks.token.mockResolvedValue('job-scoped-token')
  mocks.fetch.mockResolvedValue(Response.json({ logs: 'Code signing failed', cursor: 12, first_available_id: 1, truncated: false, retention: 'Recent buffered logs only' }))
  vi.stubGlobal('fetch', mocks.fetch)
})

afterEach(() => vi.unstubAllGlobals())

describe('native build log monitoring', () => {
  it('uses the actual builder snapshot route, returns explanations, and never cancels on disconnect', async () => {
    const controller = new AbortController()
    const response = await app.request('http://local/?cursor=7', { signal: controller.signal })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ cursor: 12, format: 'text', diagnostics: [expect.objectContaining({ classification: 'error', evidence: 'Code signing failed' })] })
    const [url, init] = mocks.fetch.mock.calls[0]
    expect(String(url)).toBe('https://builder.example.com/build_logs_direct/example-cloud-job/snapshot?cursor=7')
    expect(init.headers).toEqual({ 'x-capgo-log-token': 'job-scoped-token' })
    controller.abort()
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(mocks.permission).toHaveBeenCalledTimes(1)
  })
  it('rejects a job bound to a different app before minting a token or contacting the builder', async () => {
    mocks.query.mockResolvedValue([{ app_id: 'com.example.other' }])
    expect((await app.request('http://local/')).status).toBeGreaterThanOrEqual(400)
    expect(mocks.token).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('requires log permission', async () => {
    mocks.permission.mockResolvedValue(false)
    expect((await app.request('http://local/')).status).toBeGreaterThanOrEqual(400)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('rejects invalid cursors', async () => {
    expect((await app.request('http://local/?cursor=-1')).status).toBeGreaterThanOrEqual(400)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('reports unavailable builder snapshots as an error, not empty successful logs', async () => {
    mocks.fetch.mockResolvedValue(new Response('not found', { status: 404 }))
    expect((await app.request('http://local/')).status).toBeGreaterThanOrEqual(400)
  })
})

it.each([
  () => new Response('{broken', { headers: { 'content-type': 'application/json' } }),
  () => Response.json({ logs: null }),
])('identifies incompatible builder responses as snapshot dependency errors', async (response) => {
  mocks.fetch.mockResolvedValue(response())
  const result = await app.request('http://local/')
  expect(result.status).toBe(502)
  expect(await result.text()).toContain('builder_error')
})
