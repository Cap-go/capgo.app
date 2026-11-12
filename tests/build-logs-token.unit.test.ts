import { Hono } from 'hono'
import { decodeJwt, jwtVerify } from 'jose'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getBuildLogsToken } from '../supabase/functions/_backend/public/build/logs_token.ts'
import { onError } from '../supabase/functions/_backend/utils/on_error.ts'

const JWT_SECRET = 'example-jwt-secret'
const USER_ID = '6f0d1a2e-59ed-4769-b9d7-4d9615b28fe5'
const mocks = vi.hoisted(() => ({ query: vi.fn(), permission: vi.fn(), env: {} as Record<string, string> }))

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  authPrincipal: () => ({ kind: 'jwt', userId: USER_ID }),
  withRlsContext: async (_c: unknown, _principal: unknown, fn: (client: unknown) => unknown) => fn({}),
  queryJson: (...args: unknown[]) => mocks.query(...args),
}))
vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({ checkPermission: (...args: unknown[]) => mocks.permission(...args) }))
vi.mock('../supabase/functions/_backend/utils/discord.ts', () => ({ sendDiscordAlert500: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({ capturePosthogException: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({ backgroundTask: vi.fn(), getEnv: (_c: unknown, key: string) => mocks.env[key] ?? '' }))

const app = new Hono()
app.onError(onError('build'))
app.use(async (c, next) => {
  c.set('auth' as never, { userId: USER_ID, authType: 'jwt', jwt: 'session', apikey: null } as never)
  await next()
})
app.get('/logs_token/:jobId', c => getBuildLogsToken(c, c.req.param('jobId')))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.env = { JWT_SECRET, PUBLIC_URL: 'https://api.example.com' }
  mocks.query.mockResolvedValue([{ app_id: 'com.example.app' }])
  mocks.permission.mockResolvedValue(true)
})

describe('GET /build/logs_token/:jobId', () => {
  it('returns a one hour read-only stream token for a readable build', async () => {
    const res = await app.request('/logs_token/job_abc')
    expect(res.status).toBe(200)
    const body = await res.json() as { logs_url: string, logs_token: string }
    expect(body.logs_url).toBe('https://api.example.com/build_logs_direct/job_abc')

    const { payload } = await jwtVerify(body.logs_token, new TextEncoder().encode(JWT_SECRET), { issuer: 'capgo', audience: 'build-logs', subject: USER_ID })
    expect(payload).toMatchObject({ job_id: 'job_abc', app_id: 'com.example.app', role: 'read' })
    expect(payload.exp! - payload.iat!).toBe(60 * 60)
    expect(mocks.permission).toHaveBeenCalledWith(expect.anything(), 'app.read_logs', { appId: 'com.example.app' })
    expect(mocks.query).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('builder_job_id = $1'), ['job_abc'])
  })

  it('rejects callers without app.read_logs', async () => {
    mocks.permission.mockResolvedValue(false)
    const res = await app.request('/logs_token/job_abc')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'unauthorized' })
  })

  it('does not reveal builds the caller cannot see', async () => {
    mocks.query.mockResolvedValue([])
    const res = await app.request('/logs_token/job_missing')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'unauthorized' })
    expect(mocks.permission).not.toHaveBeenCalled()
  })

  it('fails closed when the signing secret is missing', async () => {
    mocks.env = {}
    const res = await app.request('/logs_token/job_abc')
    expect(await res.json()).toMatchObject({ error: 'config_error' })
  })
})

describe('generateLogStreamToken', () => {
  it('keeps CLI tokens free of the read role', async () => {
    const { generateLogStreamToken } = await import('../supabase/functions/_backend/public/build/start.ts')
    const payload = decodeJwt(await generateLogStreamToken('job_abc', USER_ID, 'com.example.app', JWT_SECRET))
    expect(payload.role).toBeUndefined()
    expect(payload.exp! - payload.iat!).toBe(4 * 60 * 60)
  })
})
