import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/private/cli/index.ts'

const ORG_ID = '22222222-2222-4222-8222-222222222222'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  checkPermission: vi.fn(),
  app: { app_id: 'com.example.app', owner_org: '22222222-2222-4222-8222-222222222222' } as { app_id: string, owner_org: string } | null,
  rpcResults: {} as Record<string, unknown>,
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

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: (...args: unknown[]) => mocks.checkPermission(...args),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseApikey: () => ({
    rpc: mocks.rpc,
    from: () => {
      const query: any = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: mocks.app, error: null }),
      }
      return query
    },
  }),
}))

const DEFAULT_RPC_RESULTS: Record<string, unknown> = {
  request_actor_user_id: '11111111-1111-4111-8111-111111111111',
  request_actor_email_adress: 'cli-user@example.com',
  has_2fa_enabled: false,
  get_orgs_v7: [{ gid: ORG_ID, name: 'Example Org' }],
  is_paying_org: false,
  is_trial_org: 7,
  has_usage_credits_org: false,
  is_allowed_action_org: true,
  is_allowed_action_org_action: true,
  get_organization_cli_warnings: [{ message: 'Update CLI', fatal: false }],
  reject_access_due_to_2fa_for_org: false,
  reject_access_due_to_2fa_for_app: false,
  check_org_members_2fa_enabled: [{ 'user_id': '11111111-1111-4111-8111-111111111111', '2fa_enabled': true }],
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(`http://local${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.app = { app_id: 'com.example.app', owner_org: ORG_ID }
  mocks.rpcResults = { ...DEFAULT_RPC_RESULTS }
  mocks.checkPermission.mockResolvedValue(true)
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name in mocks.rpcResults)
      return { data: mocks.rpcResults[name], error: null }
    return { data: null, error: new Error(`unexpected rpc ${name}`) }
  })
})

describe('private/cli versioning', () => {
  it('serves the default capgo_api version when the header is missing', async () => {
    const response = await app.request('http://local/identity', { method: 'GET' })
    expect(response.status).toBe(200)
  })

  it('rejects an unsupported capgo_api version', async () => {
    const response = await app.request('http://local/identity', { method: 'GET', headers: { capgo_api: '2099-01-01' } })
    expect(response.status).toBe(400)
    const body = await response.json() as { error?: string }
    expect(body.error).toBe('unsupported_capgo_api_version')
  })
})

describe('private/cli routes', () => {
  it('gET /identity returns actor identity fields', async () => {
    const response = await app.request('http://local/identity', { method: 'GET', headers: { capgo_api: '2025-10-01' } })
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body).toEqual({
      userId: mocks.apikey.user_id,
      email: 'cli-user@example.com',
      has2fa: false,
      apikey_id: 42,
    })
  })

  it('gET /organizations returns org rows', async () => {
    const response = await app.request('http://local/organizations', { method: 'GET' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([{ gid: ORG_ID, name: 'Example Org' }])
    expect(mocks.checkPermission).not.toHaveBeenCalled()
  })

  it('gET /organizations?permission= flags orgs the key may use', async () => {
    mocks.checkPermission.mockResolvedValueOnce(false)
    const response = await app.request('http://local/organizations?permission=org.create_app', { method: 'GET' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([{ gid: ORG_ID, name: 'Example Org', allowed: false }])
    expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), 'org.create_app', { orgId: ORG_ID })
  })

  it('pOST /permissions checks every permission in one scope', async () => {
    mocks.checkPermission.mockImplementation(async (_c: unknown, permission: string) => permission !== 'app.create_channel')
    const response = await post('/permissions', {
      permissions: ['channel.promote_bundle', 'app.create_channel'],
      app_id: 'com.example.app',
      channel_id: 7,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      permissions: { 'channel.promote_bundle': true, 'app.create_channel': false },
    })
    expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), 'channel.promote_bundle', { appId: 'com.example.app', channelId: 7 })
  })

  it('pOST /permissions requires a scope', async () => {
    const response = await post('/permissions', { permissions: ['app.read'] })
    expect(response.status).toBe(400)
  })

  it('gET /members/2fa-status returns member rows', async () => {
    const response = await app.request(`http://local/members/2fa-status?org_id=${ORG_ID}`, { method: 'GET' })
    expect(response.status).toBe(200)
    const body = await response.json() as Array<Record<string, unknown>>
    expect(body[0]).toMatchObject({ 'user_id': mocks.apikey.user_id, '2fa_enabled': true })
  })
})

describe('pOST /preflight', () => {
  it('returns org, trial and warnings when every check passes', async () => {
    const response = await post('/preflight', {
      app_id: 'com.example.app',
      permission: 'app.upload_bundle',
      plan: 'upload',
      cli_version: '8.0.0',
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user_id: mocks.apikey.user_id,
      org_id: ORG_ID,
      app_id: 'com.example.app',
      trial_days_left: 7,
      warnings: [{ message: 'Update CLI', fatal: false }],
    })
    expect(mocks.rpc).toHaveBeenCalledWith('reject_access_due_to_2fa_for_app', { app_id: 'com.example.app' })
    expect(mocks.rpc).toHaveBeenCalledWith('is_allowed_action_org_action', { orgid: ORG_ID, actions: ['storage'], appid: 'com.example.app' })
    expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), 'app.upload_bundle', { appId: 'com.example.app' })
  })

  it('omits trial days for paying orgs and skips optional checks', async () => {
    mocks.rpcResults.is_paying_org = true
    const response = await post('/preflight', { org_id: ORG_ID, plan: 'all', check_2fa: false })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ org_id: ORG_ID, app_id: null, trial_days_left: null, warnings: [] })
    expect(mocks.rpc).toHaveBeenCalledWith('is_allowed_action_org', { orgid: ORG_ID })
    expect(mocks.rpc).not.toHaveBeenCalledWith('reject_access_due_to_2fa_for_org', expect.anything())
  })

  it('fails with 2fa_required before touching the app', async () => {
    mocks.rpcResults.reject_access_due_to_2fa_for_app = true
    const response = await post('/preflight', { app_id: 'com.example.app', permission: 'app.read' })
    expect(response.status).toBe(403)
    expect(mocks.checkPermission).not.toHaveBeenCalled()
  })

  it('fails with app_not_found when the key cannot see the app', async () => {
    mocks.app = null
    const response = await post('/preflight', { app_id: 'com.example.app', permission: 'app.read' })
    expect(response.status).toBe(404)
  })

  it('lets channel-scoped keys through without app visibility', async () => {
    mocks.app = null
    const response = await post('/preflight', { app_id: 'com.example.app', channel_id: 3, permission: 'channel.promote_bundle' })
    expect(response.status).toBe(200)
    expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), 'channel.promote_bundle', { appId: 'com.example.app', channelId: 3 })
  })

  it('fails with permission_denied when RBAC denies', async () => {
    mocks.checkPermission.mockResolvedValue(false)
    const response = await post('/preflight', { app_id: 'com.example.app', permission: 'app.delete' })
    expect(response.status).toBe(403)
  })

  it('separates billing limits from app-scoped billing read denials', async () => {
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'is_allowed_action_org_action')
        return { data: !('appid' in args), error: null }
      return { data: mocks.rpcResults[name] ?? null, error: null }
    })
    const denied = await post('/preflight', { app_id: 'com.example.app', plan: 'all' })
    expect(denied.status).toBe(403)

    mocks.rpcResults.is_allowed_action_org_action = false
    mocks.rpc.mockImplementation(async (name: string) => ({ data: mocks.rpcResults[name] ?? null, error: null }))
    const exhausted = await post('/preflight', { app_id: 'com.example.app', plan: 'all' })
    expect(exhausted.status).toBe(402)
  })

  it('rejects an invalid app id', async () => {
    const response = await post('/preflight', { app_id: 'not an app id' })
    expect(response.status).toBe(400)
  })
})
