import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/private/config.ts'
import { MIN_CLI_VERSION, MIN_CLI_VERSION_REASON } from '../supabase/functions/_backend/utils/cliMinVersion.ts'

const connect = vi.hoisted(() => vi.fn(() => { throw new Error('No database lookup expected') }))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({ getPgClient: connect, closeClient: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of ['APPLE_SIGN_IN_CLIENT_ID', 'APPLE_SIGN_IN_TEAM_ID', 'APPLE_SIGN_IN_KEY_ID', 'APPLE_SIGN_IN_PRIVATE_KEY']) vi.stubEnv(key, 'configured-example')
  vi.stubEnv('SUPABASE_URL', 'https://testproject.supabase.co')
  vi.stubEnv('SUPABASE_ANON_KEY', 'test-anon-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('get /private/config', () => {
  it('returns the CLI min version and why it is required', async () => {
    const response = await app.request('http://local/', { method: 'GET' })

    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body.minCliVersion).toBe(MIN_CLI_VERSION)
    expect(body.minCliVersionReason).toBe(MIN_CLI_VERSION_REASON)
    expect(String(body.minCliVersionReason).length).toBeGreaterThan(0)
    expect(body.supbaseId).toBe('testproject')
    expect(body.useNewFinalizeBundleUpload).toBe(false)
    expect(connect).not.toHaveBeenCalled()
  })

  it('preserves the deprecated Apple response field as false without backend discovery', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No provider readiness request expected'))
    try {
      const response = await app.request('http://local/', { method: 'GET' })

      expect(response.status).toBe(200)
      const body = await response.json() as Record<string, unknown>
      expect(body).toHaveProperty('nativeAppleLoginEnabled', false)
      expect(typeof body.nativeAppleLoginEnabled).toBe('boolean')
      expect(connect).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    }
    finally {
      fetch.mockRestore()
    }
  })
})
