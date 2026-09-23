import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/private/cli/index.ts'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  apikey: {
    id: 42,
    key: 'test-api-key',
    user_id: '11111111-1111-4111-8111-111111111111',
  },
}))

vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({
  middlewareKey: () => async (c: any, next: () => Promise<void>) => {
    c.set('apikey', mocks.apikey)
    c.set('capgkey', mocks.apikey.key)
    await next()
  },
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseApikey: () => ({
    rpc: mocks.rpc,
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'request_actor_user_id')
      return { data: mocks.apikey.user_id, error: null }
    if (name === 'request_actor_email_adress')
      return { data: 'cli-user@example.com', error: null }
    if (name === 'has_2fa_enabled')
      return { data: false, error: null }
    if (name === 'cli_check_permission')
      return { data: true, error: null }
    if (name === 'get_orgs_v7')
      return { data: [{ gid: '22222222-2222-4222-8222-222222222222', name: 'Example Org' }], error: null }
    return { data: null, error: new Error(`unexpected rpc ${name}`) }
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('private/cli routes', () => {
  it('GET /identity returns actor identity fields', async () => {
    const response = await app.request('http://local/identity', { method: 'GET' })
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body.userId).toBe(mocks.apikey.user_id)
    expect(body.email).toBe('cli-user@example.com')
    expect(body.has2fa).toBe(false)
    expect(body.apikey_id).toBe(42)
  })

  it('POST /check-permission returns allowed boolean', async () => {
    const response = await app.request('http://local/check-permission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        permission_key: 'app.read',
        app_id: 'com.example.app',
      }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { allowed?: boolean }
    expect(body.allowed).toBe(true)
    expect(mocks.rpc).toHaveBeenCalledWith('cli_check_permission', {
      apikey: mocks.apikey.key,
      permission_key: 'app.read',
      org_id: undefined,
      app_id: 'com.example.app',
      channel_id: undefined,
    })
  })

  it('GET /organizations returns get_orgs_v7 rows', async () => {
    const response = await app.request('http://local/organizations', { method: 'GET' })
    expect(response.status).toBe(200)
    const body = await response.json() as Array<Record<string, unknown>>
    expect(body).toEqual([{ gid: '22222222-2222-4222-8222-222222222222', name: 'Example Org' }])
  })
})
