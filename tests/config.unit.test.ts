import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/private/config.ts'
import { MIN_CLI_VERSION, MIN_CLI_VERSION_REASON } from '../supabase/functions/_backend/utils/cliMinVersion.ts'

beforeEach(() => {
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
  })
})
