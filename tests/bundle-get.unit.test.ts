import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { HTTPException } from 'hono/http-exception'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const checkPermissionMock = vi.fn()
const queryJsonMock = vi.fn()
const withRlsContextMock = vi.fn()

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: (...args: unknown[]) => checkPermissionMock(...args),
}))

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  apikeyPrincipal: (_c: unknown, apikey: string) => ({ kind: 'apikey', apikey }),
  withRlsContext: (c: unknown, principal: unknown, run: (client: unknown) => unknown) => {
    withRlsContextMock(principal)
    return run({})
  },
  queryJson: (_client: unknown, text: string, values: unknown[]) => queryJsonMock(text, values),
  queryJsonOne: async (_client: unknown, text: string, values: unknown[]) => (await queryJsonMock(text, values))[0] ?? null,
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', async () => {
  const actual = await vi.importActual<typeof import('../supabase/functions/_backend/utils/utils.ts')>('../supabase/functions/_backend/utils/utils.ts')
  return {
    ...actual,
    isValidAppId: (appId: string) => typeof appId === 'string' && appId.includes('.'),
    fetchLimit: 50,
  }
})

const { BUNDLE_SUMMARY_COLUMNS, get } = await import('../supabase/functions/_backend/public/bundle/get.ts')

const apikey = {
  key: 'test-apikey',
  user_id: 'user-1',
} as any

function causeErrorCode(error: HTTPException) {
  return (error.cause as { error: string }).error
}

function createContext(auth?: { userId: string }) {
  return {
    get: vi.fn((key: string) => {
      if (key === 'requestId')
        return 'req-1'
      if (key === 'auth')
        return auth
      return undefined
    }),
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as unknown as Context<MiddlewareKeyVariables>
}

function mockRows(rows: unknown[] | Error) {
  if (rows instanceof Error)
    queryJsonMock.mockRejectedValue(rows)
  else
    queryJsonMock.mockResolvedValue(rows)
}

function lastQuery() {
  const [text, values] = queryJsonMock.mock.calls.at(-1) as [string, unknown[]]
  return { text, values }
}

describe('bundle GET handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    checkPermissionMock.mockResolvedValue(true)
  })

  it('returns 401 when auth context is missing', async () => {
    const error = await get(createContext(undefined), { app_id: 'com.example.app' }, apikey).catch(caught => caught) as HTTPException
    expect(error).toBeInstanceOf(HTTPException)
    expect(error.status).toBe(401)
    expect(causeErrorCode(error)).toBe('invalid_apikey')
  })

  it('returns 404 when permission is denied and the app is not visible', async () => {
    checkPermissionMock.mockResolvedValue(false)
    mockRows([])

    const error = await get(createContext({ userId: 'user-1' }), { app_id: 'com.missing.app' }, apikey).catch(caught => caught) as HTTPException
    expect(error).toBeInstanceOf(HTTPException)
    expect(error.status).toBe(404)
    expect(causeErrorCode(error)).toBe('app_not_found')
  })

  it('returns 403 when permission is denied but the app exists', async () => {
    checkPermissionMock.mockResolvedValue(false)
    mockRows([{ app_id: 'com.example.app' }])

    const error = await get(createContext({ userId: 'user-1' }), { app_id: 'com.example.app' }, apikey).catch(caught => caught) as HTTPException
    expect(error).toBeInstanceOf(HTTPException)
    expect(error.status).toBe(403)
    expect(causeErrorCode(error)).toBe('cannot_get_bundle')
  })

  it('returns 500 when bundle query fails', async () => {
    mockRows(new Error('db down'))

    const error = await get(createContext({ userId: 'user-1' }), { app_id: 'com.example.app' }, apikey).catch(caught => caught) as HTTPException
    expect(error).toBeInstanceOf(HTTPException)
    expect(error.status).toBe(500)
    expect(causeErrorCode(error)).toBe('cannot_get_bundle')
  })

  it.each([
    ['bundle rows', [{ id: 1, name: '1.0.0', app_id: 'com.example.app' }]],
    ['an empty array when the app has no bundles', []],
  ])('returns %s on success', async (_label, rows) => {
    mockRows(rows)

    const response = await get(createContext({ userId: 'user-1' }), { app_id: 'com.example.app' }, apikey)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(rows)
    expect(withRlsContextMock).toHaveBeenCalledWith({ kind: 'apikey', apikey: 'test-apikey' })
  })

  it('excludes deleted bundles by default on version lookup', async () => {
    mockRows([])

    const response = await get(createContext({ userId: 'user-1' }), { app_id: 'com.example.app', version: '1.0.0' }, apikey)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
    expect(lastQuery().text).toContain('deleted = false')
    expect(lastQuery().values).toEqual(['com.example.app', '1.0.0'])
  })

  it('include_deleted matches soft-deleted bundles for name occupancy checks', async () => {
    const row = { id: 12, name: '1.0.0', checksum: 'abc', deleted: true, created_at: '2026-01-01T00:00:00.000Z' }
    mockRows([row])

    const response = await get(createContext({ userId: 'user-1' }), { app_id: 'com.example.app', version: '1.0.0', include_deleted: '1' }, apikey)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([row])
    expect(lastQuery().text).not.toContain('deleted = false')
    expect(lastQuery().text).toContain('name = $2')
    expect(lastQuery().values).toEqual(['com.example.app', '1.0.0'])
  })

  it('returns full rows by default', async () => {
    mockRows([])

    await get(createContext({ userId: 'user-1' }), { app_id: 'com.example.app' }, apikey)
    expect(lastQuery().text).toMatch(/^SELECT \* FROM public\.app_versions /)
    expect(lastQuery().values).toEqual(['com.example.app', 50, 0])
  })

  it('fields=summary skips manifest and native_packages', async () => {
    mockRows([])

    await get(createContext({ userId: 'user-1' }), { app_id: 'com.example.app', fields: 'summary' }, apikey)
    expect(lastQuery().text).toContain(`SELECT ${BUNDLE_SUMMARY_COLUMNS} FROM`)
    expect(BUNDLE_SUMMARY_COLUMNS).not.toMatch(/manifest,|native_packages/)
    expect(BUNDLE_SUMMARY_COLUMNS).toContain('manifest_count')
  })

  it('limit sets the page size and page counts in that size', async () => {
    mockRows([])

    await get(createContext({ userId: 'user-1' }), { app_id: 'com.example.app', limit: '1000', page: '2' }, apikey)
    expect(lastQuery().values).toEqual(['com.example.app', 1000, 2000])
  })

  it.each(['0', '1001', 'abc'])('rejects limit=%s', async (limit) => {
    const error = await get(createContext({ userId: 'user-1' }), { app_id: 'com.example.app', limit }, apikey).catch(caught => caught) as HTTPException
    expect(error).toBeInstanceOf(HTTPException)
    expect(causeErrorCode(error)).toBe('invalid_query')
  })
})
