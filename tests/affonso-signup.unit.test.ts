import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockedEnv: Record<string, string> = {}
const userRow = vi.fn()

vi.mock('hono/adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hono/adapter')>()
  return {
    ...actual,
    env: () => mockedEnv,
  }
})

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: vi.fn(async () => ({})),
  closeClient: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  queryJsonOne: vi.fn(async () => userRow()),
}))

const NOW = Date.parse('2026-11-28T12:00:00Z')
const fetchMock = vi.fn()

function createContext(userId?: string) {
  return {
    get: (key: string) => {
      if (key === 'requestId')
        return 'request-id'
      if (key === 'auth')
        return userId ? { userId } : undefined
      return undefined
    },
    req: { header: () => undefined },
  } as any
}

beforeEach(() => {
  for (const key of Object.keys(mockedEnv))
    delete mockedEnv[key]
  Object.assign(mockedEnv, { AFFONSO_API_KEY: 'sk_live_affonso', CAPGO_PREVENT_BACKGROUND_FUNCTIONS: 'true' })
  userRow.mockReset()
  userRow.mockReturnValue({ email: 'buyer@example.com', first_name: 'Ada', last_name: 'Lovelace', created_at: '2026-11-20T10:00:00Z' })
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, data: { id: 'clk_1', status: 'lead' } }), { status: 201 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('trackAffonsoSignup', () => {
  it('sends the signup with the user email, name and id', async () => {
    const { trackAffonsoSignup } = await import('../supabase/functions/_backend/utils/affonso.ts')

    await expect(trackAffonsoSignup(createContext(), 'clk_1', 'user-1', { requireRecentAccount: true, now: NOW })).resolves.toBe('tracked')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.affonso.io/v1/signups')
    expect(init.headers.Authorization).toBe('Bearer sk_live_affonso')
    expect(JSON.parse(init.body)).toEqual({
      click_id: 'clk_1',
      email: 'buyer@example.com',
      external_user_id: 'user-1',
      name: 'Ada Lovelace',
    })
  })

  it('omits an empty name', async () => {
    userRow.mockReturnValue({ email: 'buyer@example.com', first_name: '', last_name: null, created_at: null })
    const { trackAffonsoSignup } = await import('../supabase/functions/_backend/utils/affonso.ts')

    await trackAffonsoSignup(createContext(), 'clk_1', 'user-1')

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('name')
  })

  it('skips accounts older than the affiliate cookie when a recent account is required', async () => {
    userRow.mockReturnValue({ email: 'old@example.com', first_name: 'Old', last_name: 'User', created_at: '2026-09-01T00:00:00Z' })
    const { trackAffonsoSignup } = await import('../supabase/functions/_backend/utils/affonso.ts')

    await expect(trackAffonsoSignup(createContext(), 'clk_1', 'user-1', { requireRecentAccount: true, now: NOW })).resolves.toBe('account_too_old')
    await expect(trackAffonsoSignup(createContext(), 'clk_1', 'user-1', { now: NOW })).resolves.toBe('tracked')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed click ids and missing configuration without calling Affonso', async () => {
    const { trackAffonsoSignup } = await import('../supabase/functions/_backend/utils/affonso.ts')

    await expect(trackAffonsoSignup(createContext(), 'clk 1;<script>', 'user-1')).resolves.toBe('invalid_click')
    await expect(trackAffonsoSignup(createContext(), 42, 'user-1')).resolves.toBe('invalid_click')
    delete mockedEnv.AFFONSO_API_KEY
    await expect(trackAffonsoSignup(createContext(), 'clk_1', 'user-1')).resolves.toBe('no_api_key')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws when Affonso rejects the signup', async () => {
    fetchMock.mockResolvedValue(new Response('{"success":false,"error":{"code":"CLICK_NOT_FOUND"}}', { status: 404 }))
    const { trackAffonsoSignup } = await import('../supabase/functions/_backend/utils/affonso.ts')

    await expect(trackAffonsoSignup(createContext(), 'clk_1', 'user-1')).rejects.toThrow('responded 404')
  })
})

describe('scheduleAffonsoSignup', () => {
  it('records the signup for the authenticated user and never throws', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    const { scheduleAffonsoSignup } = await import('../supabase/functions/_backend/utils/affonso.ts')

    expect(() => scheduleAffonsoSignup(createContext('user-1'), 'clk_1')).not.toThrow()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it('does nothing without a user or click id', async () => {
    const { scheduleAffonsoSignup } = await import('../supabase/functions/_backend/utils/affonso.ts')

    scheduleAffonsoSignup(createContext(), 'clk_1')
    scheduleAffonsoSignup(createContext('user-1'), undefined)
    scheduleAffonsoSignup(createContext('user-1'), '')
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(userRow).not.toHaveBeenCalled()
  })
})
