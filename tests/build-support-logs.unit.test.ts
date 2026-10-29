import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { checkPermissionMock, pgQueryMock, drizzleExecuteMock } = vi.hoisted(() => ({
  checkPermissionMock: vi.fn(),
  pgQueryMock: vi.fn(),
  drizzleExecuteMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: checkPermissionMock,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: vi.fn(() => ({ id: 'pg-client', query: pgQueryMock })),
  getDrizzleClient: vi.fn(() => ({ execute: drizzleExecuteMock })),
  closeClient: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlogErr: vi.fn(),
}))

const { hasSupportLogUploadPermission, uploadSupportLogs } = await import('../supabase/functions/_backend/public/build/support_logs.ts')

const apikey = { user_id: 'user-1' } as any

function createContext() {
  return {
    req: { url: 'http://localhost/build/support_logs' },
    env: {
      BUILDER_URL: 'https://builder.test',
      BUILDER_API_KEY: 'builder-key',
    },
    get: vi.fn((key: string) => key === 'requestId' ? 'req-test' : undefined),
    json: vi.fn((data: unknown, status = 200) => new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json' },
    })),
  } as any
}

function mockAdminRows(rows: { user?: unknown, buildRequest?: unknown }) {
  pgQueryMock.mockImplementation(async (text: string) => {
    if (text.includes('FROM public.users'))
      return { rows: rows.user ? [rows.user] : [] }
    if (text.includes('FROM public.build_requests'))
      return { rows: rows.buildRequest ? [rows.buildRequest] : [] }
    throw new Error(`unexpected query ${text}`)
  })
}

function buildRequestLookups() {
  return pgQueryMock.mock.calls.filter(([text]) => String(text).includes('FROM public.build_requests'))
}

beforeEach(() => {
  vi.restoreAllMocks()
  checkPermissionMock.mockReset()
  checkPermissionMock.mockResolvedValue(true)
  pgQueryMock.mockReset()
  drizzleExecuteMock.mockReset()
  vi.stubEnv('BUILDER_URL', 'https://builder.test')
  vi.stubEnv('BUILDER_API_KEY', 'builder-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('uploadSupportLogs metadata forwarding', () => {
  it('forwards user email and derives platform from the build request job id', async () => {
    mockAdminRows({
      user: { email: 'dev@capgo.app' },
      buildRequest: { platform: 'ios' },
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'log-1', url: 'https://api.test/log-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await uploadSupportLogs(createContext(), apikey, {
      appId: 'com.test.app',
      jobId: 'job-1',
      gzB64: 'not-empty',
    })

    expect(res.status).toBe(200)
    const lookups = buildRequestLookups()
    expect(lookups).toHaveLength(1)
    expect(lookups[0][0]).toContain('builder_job_id = $1 AND requested_by = $2 AND ($3::text IS NULL OR app_id = $3)')
    expect(lookups[0][1]).toEqual(['job-1', 'user-1', 'com.test.app'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({
      appId: 'com.test.app',
      jobId: 'job-1',
      userId: 'user-1',
      email: 'dev@capgo.app',
      platform: 'ios',
    })
  })

  it('forwards the caller supplied platform when there is no job lookup path', async () => {
    mockAdminRows({ user: { email: 'dev@capgo.app' } })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'log-2', url: 'https://api.test/log-2' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await uploadSupportLogs(createContext(), apikey, {
      appId: 'com.test.app',
      platform: 'android',
      gzB64: 'not-empty',
    })

    expect(pgQueryMock).toHaveBeenCalledTimes(1)
    expect(buildRequestLookups()).toHaveLength(0)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({
      email: 'dev@capgo.app',
      platform: 'android',
    })
  })

  it('ignores unsupported caller supplied platform values', async () => {
    mockAdminRows({ user: { email: 'dev@capgo.app' } })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'log-3', url: 'https://api.test/log-3' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await uploadSupportLogs(createContext(), apikey, {
      appId: 'com.test.app',
      platform: 'web' as never,
      gzB64: 'not-empty',
    })

    expect(pgQueryMock).toHaveBeenCalledTimes(1)
    expect(buildRequestLookups()).toHaveLength(0)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.email).toBe('dev@capgo.app')
    expect(body.platform).toBeUndefined()
  })
})

describe('support logs RBAC upload gate', () => {
  const rbacApikey = {
    rbac_id: '00000000-0000-0000-0000-000000000123',
  }

  it('allows registered app uploads only with app.build_native', async () => {
    await expect(hasSupportLogUploadPermission(createContext(), rbacApikey as any, 'com.test.app')).resolves.toBe(true)

    expect(checkPermissionMock).toHaveBeenCalledWith(expect.anything(), 'app.build_native', { appId: 'com.test.app' })
    expect(drizzleExecuteMock).not.toHaveBeenCalled()
  })

  it('denies read-only keys for registered apps', async () => {
    checkPermissionMock.mockResolvedValueOnce(false)
    drizzleExecuteMock.mockResolvedValueOnce({ rows: [{ exists: true }] })

    await expect(hasSupportLogUploadPermission(createContext(), rbacApikey as any, 'com.test.app')).resolves.toBe(false)

    expect(drizzleExecuteMock).toHaveBeenCalledTimes(1)
  })

  it('uses current org write capability only when the app is not registered yet', async () => {
    checkPermissionMock.mockResolvedValueOnce(false)
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ exists: false }] })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })

    await expect(hasSupportLogUploadPermission(createContext(), rbacApikey as any, 'com.new.app')).resolves.toBe(true)

    expect(drizzleExecuteMock).toHaveBeenCalledTimes(2)
  })

  it('denies app-less uploads without a current write-capable org binding', async () => {
    drizzleExecuteMock.mockResolvedValueOnce({ rows: [{ allowed: false }] })

    await expect(hasSupportLogUploadPermission(createContext(), rbacApikey as any)).resolves.toBe(false)

    expect(checkPermissionMock).not.toHaveBeenCalled()
    expect(drizzleExecuteMock).toHaveBeenCalledTimes(1)
  })
})
