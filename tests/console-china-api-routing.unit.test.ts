import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeJwt, memoryStorage } from './console-auth-fixtures'

const CHINA_CONSOLE_HOST = 'console.capgo.com.cn'
const GLOBAL_API = 'https://api.capgo.app'
const CHINA_API = 'https://api.capgo.com.cn'

function stubChinaConsoleWeb() {
  vi.stubEnv('VITE_API_HOST', GLOBAL_API)
  vi.stubEnv('VITE_APP_URL', `https://${CHINA_CONSOLE_HOST}`)
  vi.stubGlobal('window', {
    location: { hostname: CHINA_CONSOLE_HOST, origin: `https://${CHINA_CONSOLE_HOST}` },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
}

describe('China console API routing', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    stubChinaConsoleWeb()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('getLocalConfig uses the China API host on console.capgo.com.cn', async () => {
    const { getLocalConfig } = await import('../src/services/console')
    expect(getLocalConfig().apiHost).toBe(CHINA_API)
  })

  it('createConsoleClient routes queries and auth to the China API host', async () => {
    const { createConsoleClient } = await import('../src/services/consoleClient')
    const { SESSION_STORAGE_KEY } = await import('../src/services/consoleAuth')

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [], error: null, count: null, status: 200 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const storage = memoryStorage()
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
      access_token: fakeJwt({ sub: 'user-1' }),
      refresh_token: 'refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'user-1' },
    }))
    vi.stubGlobal('localStorage', storage)
    await createConsoleClient().from('orgs').select('id').limit(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`${CHINA_API}/private/console/query`)

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      access_token: fakeJwt({ sub: 'user-1', email: 'user@example.com' }),
      refresh_token: 'refresh',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user: { id: 'user-1', email: 'user@example.com' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('localStorage', memoryStorage())
    await createConsoleClient({ persistSession: false }).auth.signInWithPassword({ email: 'user@example.com', password: 'pw' })
    expect(fetchMock.mock.calls[1][0]).toBe(`${CHINA_API}/private/console/auth/token?grant_type=password`)
  })
})