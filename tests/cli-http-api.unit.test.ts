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
    if (name === 'is_paying_org')
      return { data: true, error: null }
    if (name === 'is_trial_org')
      return { data: 7, error: null }
    if (name === 'has_usage_credits_org')
      return { data: false, error: null }
    if (name === 'is_allowed_action_org')
      return { data: true, error: null }
    if (name === 'is_allowed_action_org_action')
      return { data: true, error: null }
    if (name === 'get_organization_cli_warnings')
      return { data: [{ message: 'Update CLI', fatal: false }], error: null }
    if (name === 'reject_access_due_to_2fa_for_org')
      return { data: false, error: null }
    if (name === 'reject_access_due_to_2fa_for_app')
      return { data: false, error: null }
    if (name === 'check_org_members_2fa_enabled')
      return { data: [{ user_id: mocks.apikey.user_id, '2fa_enabled': true }], error: null }
    if (name === 'check_org_members_password_policy')
      return { data: [{ user_id: mocks.apikey.user_id, email: 'cli-user@example.com', first_name: 'CLI', last_name: 'User', password_policy_compliant: true }], error: null }
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

  it('GET /billing/entitlements returns billing flags', async () => {
    const response = await app.request(
      'http://local/billing/entitlements?org_id=22222222-2222-4222-8222-222222222222',
      { method: 'GET' },
    )
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body).toEqual({ isPaying: true, trialDays: 7, hasCredits: false })
  })

  it('POST /billing/allowed-actions returns allowed boolean', async () => {
    const response = await app.request('http://local/billing/allowed-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        org_id: '22222222-2222-4222-8222-222222222222',
        actions: ['storage'],
      }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { allowed?: boolean }
    expect(body.allowed).toBe(true)
  })

  it('GET /warnings returns CLI warning rows', async () => {
    const response = await app.request(
      'http://local/warnings?org_id=22222222-2222-4222-8222-222222222222&cli_version=1.0.0',
      { method: 'GET' },
    )
    expect(response.status).toBe(200)
    const body = await response.json() as Array<Record<string, unknown>>
    expect(body).toEqual([{ message: 'Update CLI', fatal: false }])
  })

  it('GET /2fa/reject-org returns reject boolean', async () => {
    const response = await app.request(
      'http://local/2fa/reject-org?org_id=22222222-2222-4222-8222-222222222222',
      { method: 'GET' },
    )
    expect(response.status).toBe(200)
    const body = await response.json() as { reject?: boolean }
    expect(body.reject).toBe(false)
  })

  it('GET /members/2fa-status returns member rows', async () => {
    const response = await app.request(
      'http://local/members/2fa-status?org_id=22222222-2222-4222-8222-222222222222',
      { method: 'GET' },
    )
    expect(response.status).toBe(200)
    const body = await response.json() as Array<Record<string, unknown>>
    expect(body[0]).toMatchObject({ user_id: mocks.apikey.user_id, '2fa_enabled': true })
  })
})
