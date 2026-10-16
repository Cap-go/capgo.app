import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HTTPException } from 'hono/http-exception'

const checkPermissionMock = vi.fn()
const supabaseApikeyMock = vi.fn()

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: (...args: unknown[]) => checkPermissionMock(...args),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseApikey: (...args: unknown[]) => supabaseApikeyMock(...args),
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', async () => {
  const actual = await vi.importActual<typeof import('../supabase/functions/_backend/utils/utils.ts')>('../supabase/functions/_backend/utils/utils.ts')
  return {
    ...actual,
    isValidAppId: (appId: string) => typeof appId === 'string' && appId.includes('.'),
    fetchLimit: 50,
  }
})

const { get } = await import('../supabase/functions/_backend/public/bundle/get.ts')

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

function makeSupabaseChain(result: { data?: unknown, error?: unknown }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {}
  const self = () => chain
  chain.from = vi.fn(self)
  chain.select = vi.fn(self)
  chain.eq = vi.fn(self)
  chain.range = vi.fn(self)
  chain.order = vi.fn(() => Promise.resolve(result))
  chain.maybeSingle = vi.fn(() => Promise.resolve(result))
  return chain
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
    supabaseApikeyMock.mockReturnValue(makeSupabaseChain({ data: null, error: null }))

    const error = await get(createContext({ userId: 'user-1' }), { app_id: 'com.missing.app' }, apikey).catch(caught => caught) as HTTPException
    expect(error).toBeInstanceOf(HTTPException)
    expect(error.status).toBe(404)
    expect(causeErrorCode(error)).toBe('app_not_found')
  })

  it('returns 403 when permission is denied but the app exists', async () => {
    checkPermissionMock.mockResolvedValue(false)
    supabaseApikeyMock.mockReturnValue(makeSupabaseChain({ data: { app_id: 'com.example.app' }, error: null }))

    const error = await get(createContext({ userId: 'user-1' }), { app_id: 'com.example.app' }, apikey).catch(caught => caught) as HTTPException
    expect(error).toBeInstanceOf(HTTPException)
    expect(error.status).toBe(403)
    expect(causeErrorCode(error)).toBe('cannot_get_bundle')
  })

  it('returns 500 when bundle query fails', async () => {
    const versionsChain = makeSupabaseChain({ data: null, error: { message: 'db down' } })
    supabaseApikeyMock.mockReturnValue(versionsChain)

    const error = await get(createContext({ userId: 'user-1' }), { app_id: 'com.example.app' }, apikey).catch(caught => caught) as HTTPException
    expect(error).toBeInstanceOf(HTTPException)
    expect(error.status).toBe(500)
    expect(causeErrorCode(error)).toBe('cannot_get_bundle')
  })

  it('returns bundle rows on success', async () => {
    const rows = [{ id: 1, name: '1.0.0', app_id: 'com.example.app' }]
    const versionsChain = makeSupabaseChain({ data: rows, error: null })
    supabaseApikeyMock.mockReturnValue(versionsChain)

    const response = await get(createContext({ userId: 'user-1' }), { app_id: 'com.example.app' }, apikey)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(rows)
  })
})
