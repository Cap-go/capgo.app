import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}))

function createJwt(exp: number) {
  return `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`
}

function stubLocalStorage() {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    removeItem: vi.fn((key: string) => storage.delete(key)),
    setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
  })
  vi.stubGlobal('atob', (value: string) => Buffer.from(value, 'base64').toString('binary'))
}

describe('spoof session storage', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.createClient.mockReset()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co')
    stubLocalStorage()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })
  it('clears stale spoof storage without touching the active session when unspoof cannot restore admin', async () => {
    const refreshSession = vi.fn().mockResolvedValue({ data: { session: null }, error: new Error('invalid refresh token') })
    const setSession = vi.fn()
    mocks.createClient
      .mockReturnValueOnce({ auth: { refreshSession } })
      .mockReturnValueOnce({ auth: { setSession } })

    const { isSpoofed, saveSpoof, unspoofUser } = await import('../src/services/supabase.ts')

    saveSpoof(createJwt(1), 'stale-refresh-token')
    expect(isSpoofed()).toBe(true)

    await expect(unspoofUser()).resolves.toBe(false)

    expect(refreshSession).toHaveBeenCalledWith({ refresh_token: 'stale-refresh-token' })
    expect(setSession).not.toHaveBeenCalled()
    expect(isSpoofed()).toBe(false)
  })

  it('restores admin with a refreshed stored session before clearing spoof storage', async () => {
    const refreshSession = vi.fn().mockResolvedValue({
      data: {
        session: {
          access_token: 'fresh-admin-jwt',
          refresh_token: 'fresh-admin-refresh-token',
        },
      },
      error: null,
    })
    const setSession = vi.fn().mockResolvedValue({ data: { session: {} }, error: null })
    mocks.createClient
      .mockReturnValueOnce({ auth: { refreshSession } })
      .mockReturnValueOnce({ auth: { setSession } })

    const { isSpoofed, saveSpoof, unspoofUser } = await import('../src/services/supabase.ts')

    saveSpoof(createJwt(1), 'admin-refresh-token')
    expect(isSpoofed()).toBe(true)

    await expect(unspoofUser()).resolves.toBe(true)

    expect(setSession).toHaveBeenCalledWith({
      access_token: 'fresh-admin-jwt',
      refresh_token: 'fresh-admin-refresh-token',
    })
    expect(localStorage.setItem).toHaveBeenCalledWith(
      expect.stringContaining('.spoof_admin_jwt'),
      JSON.stringify({ jwt: 'fresh-admin-jwt', refreshToken: 'fresh-admin-refresh-token' }),
    )
    expect(isSpoofed()).toBe(false)
  })

  it('restores a valid stored admin session even when its refresh token is stale', async () => {
    const refreshSession = vi.fn()
    const setSession = vi.fn().mockResolvedValue({ data: { session: {} }, error: null })
    mocks.createClient.mockReturnValueOnce({ auth: { refreshSession, setSession } })

    const { isSpoofed, saveSpoof, unspoofUser } = await import('../src/services/supabase.ts')

    saveSpoof(createJwt(Math.floor(Date.now() / 1000) + 300), 'stale-refresh-token')

    await expect(unspoofUser()).resolves.toBe(true)

    expect(refreshSession).not.toHaveBeenCalled()
    expect(setSession).toHaveBeenCalledWith({
      access_token: expect.any(String),
      refresh_token: 'stale-refresh-token',
    })
    expect(isSpoofed()).toBe(false)
  })

  it('keeps spoof recovery storage when restoring the admin session fails', async () => {
    const setSession = vi.fn().mockResolvedValue({ data: { session: null }, error: new Error('session write failed') })
    mocks.createClient.mockReturnValueOnce({ auth: { setSession } })

    const { isSpoofed, saveSpoof, unspoofUser } = await import('../src/services/supabase.ts')

    saveSpoof(createJwt(Math.floor(Date.now() / 1000) + 300), 'admin-refresh-token')

    await expect(unspoofUser()).resolves.toBe(false)

    expect(isSpoofed()).toBe(true)
  })

  it('keeps spoof recovery storage when restoring the admin session throws', async () => {
    const setSession = vi.fn().mockRejectedValue(new Error('session write failed'))
    mocks.createClient.mockReturnValueOnce({ auth: { setSession } })

    const { isSpoofed, saveSpoof, unspoofUser } = await import('../src/services/supabase.ts')

    saveSpoof(createJwt(Math.floor(Date.now() / 1000) + 300), 'admin-refresh-token')

    await expect(unspoofUser()).resolves.toBe(false)

    expect(isSpoofed()).toBe(true)
  })

  it('keeps the refreshed spoof recovery session when restoring it throws', async () => {
    const refreshSession = vi.fn().mockResolvedValue({
      data: {
        session: {
          access_token: 'fresh-admin-jwt',
          refresh_token: 'fresh-admin-refresh-token',
        },
      },
      error: null,
    })
    const setSession = vi.fn().mockRejectedValue(new Error('session write failed'))
    mocks.createClient
      .mockReturnValueOnce({ auth: { refreshSession } })
      .mockReturnValueOnce({ auth: { setSession } })

    const { isSpoofed, saveSpoof, unspoofUser } = await import('../src/services/supabase.ts')

    saveSpoof(createJwt(1), 'stale-refresh-token')

    await expect(unspoofUser()).resolves.toBe(false)

    expect(localStorage.setItem).toHaveBeenCalledWith(
      expect.stringContaining('.spoof_admin_jwt'),
      JSON.stringify({ jwt: 'fresh-admin-jwt', refreshToken: 'fresh-admin-refresh-token' }),
    )
    expect(isSpoofed()).toBe(true)
  })

  it('clears expired spoof storage when the stored admin jwt cannot be refreshed', async () => {
    const refreshSession = vi.fn().mockResolvedValue({ data: { session: null }, error: new Error('invalid refresh token') })
    mocks.createClient.mockReturnValueOnce({ auth: { refreshSession } })

    const { getSpoofedAdminJwt, isSpoofed, saveSpoof } = await import('../src/services/supabase.ts')

    saveSpoof(createJwt(1), 'stale-refresh-token')

    await expect(getSpoofedAdminJwt()).resolves.toBeNull()

    expect(isSpoofed()).toBe(false)
  })
})
