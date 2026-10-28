import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { checkPermissionMock, rlsQueryMock, adminQueryMock, withRlsContextMock } = vi.hoisted(() => ({
  checkPermissionMock: vi.fn(),
  rlsQueryMock: vi.fn(),
  adminQueryMock: vi.fn(),
  withRlsContextMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: checkPermissionMock,
}))

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/pg_rls.ts')>()
  return {
    ...actual,
    withRlsContext: withRlsContextMock.mockImplementation(async (_c: unknown, _principal: unknown, run: (client: unknown) => unknown) => run({ query: rlsQueryMock })),
  }
})

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: vi.fn(async () => ({ query: adminQueryMock })),
  closeClient: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: vi.fn((_c: unknown, key: string) => key === 'BUILDER_URL' ? 'https://builder.test' : 'builder-key'),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
}))

const { cancelBuild } = await import('../supabase/functions/_backend/public/build/cancel.ts')
const { NATIVE_BUILD_TERMINAL_STATUSES } = await import('../supabase/functions/_backend/public/build/concurrency.ts')

function context() {
  return {
    get: vi.fn(() => 'test-request-id'),
    json: vi.fn((body: unknown, status: number) => new Response(JSON.stringify(body), { status })),
  }
}

function lookupReturns(rows: unknown[]) {
  rlsQueryMock.mockResolvedValue({ rows: rows.map(row => ({ row })) })
}

describe('cancelBuild', () => {
  const apikey = { key: 'test-key', user_id: 'user-1' }
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('persists cancelled status with the admin client so the concurrency slot frees', async () => {
    checkPermissionMock.mockResolvedValueOnce(true)
    lookupReturns([{ app_id: 'com.test.app' }])
    adminQueryMock.mockResolvedValue({ rows: [], rowCount: 1 })
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ jobId: 'job-1', status: 'cancelled' }), { status: 200 }))

    const response = await cancelBuild(context() as any, 'job-1', 'com.test.app', apikey as any)

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith('https://builder.test/jobs/job-1/cancel', expect.objectContaining({ method: 'POST' }))
    // The API-key RLS context has no UPDATE policy on build_requests; it must only be used for the lookup.
    expect(withRlsContextMock).toHaveBeenCalledWith(expect.anything(), { kind: 'apikey', apikey: 'test-key' }, expect.any(Function))
    expect(rlsQueryMock).toHaveBeenCalledTimes(1)
    expect(rlsQueryMock.mock.calls[0][0]).toMatch(/^WITH q AS \(SELECT app_id FROM public\.build_requests/)
    expect(adminQueryMock).toHaveBeenCalledTimes(1)
    const [updateSql, params] = adminQueryMock.mock.calls[0]
    expect(updateSql).toContain('UPDATE public.build_requests')
    expect(updateSql).toContain('SET status = \'cancelled\'')
    expect(updateSql).toContain('NOT (status = ANY($4::text[]))')
    expect(params.slice(0, 2)).toEqual(['job-1', 'com.test.app'])
    for (const status of ['succeeded', 'failed', 'cancelled'])
      expect(params[3]).toContain(status)
    // 'cancelled' is terminal, so the concurrency reservation no longer counts this row.
    expect(NATIVE_BUILD_TERMINAL_STATUSES).toContain('cancelled')
  })

  it('does not touch the row when the job is not bound to the app', async () => {
    checkPermissionMock.mockResolvedValueOnce(true)
    lookupReturns([])

    await expect(cancelBuild(context() as any, 'job-1', 'com.test.app', apikey as any)).rejects.toThrow()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(adminQueryMock).not.toHaveBeenCalled()
  })
})
