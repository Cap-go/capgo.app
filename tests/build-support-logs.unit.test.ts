import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { checkPermissionMock, mockSupabaseAdmin } = vi.hoisted(() => ({
  checkPermissionMock: vi.fn(),
  mockSupabaseAdmin: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: checkPermissionMock,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: mockSupabaseAdmin,
}))

const { uploadSupportLogs } = await import('../supabase/functions/_backend/public/build/support_logs.ts')

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

function makeSelectResult(data: unknown, error: unknown = null) {
  const query = {
    eq: vi.fn(),
    maybeSingle: vi.fn(async () => ({ data, error })),
  }
  query.eq.mockReturnValue(query)
  return { select: vi.fn(() => query), query }
}

function mockAdminRows(rows: { user?: unknown, buildRequest?: unknown }) {
  const userResult = makeSelectResult(rows.user ?? null)
  const buildRequestResult = makeSelectResult(rows.buildRequest ?? null)
  const from = vi.fn((table: string) => {
    if (table === 'users')
      return userResult
    if (table === 'build_requests')
      return buildRequestResult
    throw new Error(`unexpected table ${table}`)
  })
  mockSupabaseAdmin.mockReturnValue({ from })
  return { from, userQuery: userResult.query, buildRequestQuery: buildRequestResult.query }
}

beforeEach(() => {
  vi.restoreAllMocks()
  checkPermissionMock.mockReset()
  checkPermissionMock.mockResolvedValue(true)
  mockSupabaseAdmin.mockReset()
  vi.stubEnv('BUILDER_URL', 'https://builder.test')
  vi.stubEnv('BUILDER_API_KEY', 'builder-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('uploadSupportLogs metadata forwarding', () => {
  it('forwards user email and derives platform from the build request job id', async () => {
    const { buildRequestQuery } = mockAdminRows({
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
    expect(buildRequestQuery.eq).toHaveBeenCalledWith('builder_job_id', 'job-1')
    expect(buildRequestQuery.eq).toHaveBeenCalledWith('requested_by', 'user-1')
    expect(buildRequestQuery.eq).toHaveBeenCalledWith('app_id', 'com.test.app')
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
    const { from } = mockAdminRows({ user: { email: 'dev@capgo.app' } })
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

    expect(from).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({
      email: 'dev@capgo.app',
      platform: 'android',
    })
  })

  it('ignores unsupported caller supplied platform values', async () => {
    const { from } = mockAdminRows({ user: { email: 'dev@capgo.app' } })
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

    expect(from).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.email).toBe('dev@capgo.app')
    expect(body.platform).toBeUndefined()
  })
})
