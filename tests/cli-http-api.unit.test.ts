import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/private/cli/index.ts'

const ORG_ID = '22222222-2222-4222-8222-222222222222'
const APP_ROW = { app_id: 'com.example.app', owner_org: ORG_ID }

interface QueryCall {
  table: string
  text: string
  values: unknown[]
}

const mocks = vi.hoisted(() => ({
  // Caller (API-key scoped) statements: every table query is recorded and resolves to `result`.
  calls: [] as QueryCall[],
  // Every statement sent on the caller client, in order (one entry per round trip).
  statements: [] as string[],
  events: [] as string[],
  result: { data: null as unknown, error: null as unknown },
  rpc: vi.fn(),
  rpcResults: {} as Record<string, unknown>,
  principals: [] as unknown[],
  checkPermission: vi.fn(),
  // Connection-role client and R2 image store used by the icon upload.
  adminQuery: vi.fn(),
  upload: vi.fn(),
  apikey: {
    id: 42,
    key: 'test-api-key',
    user_id: '11111111-1111-4111-8111-111111111111',
  },
}))

const CALLER_CLIENT = { caller: true }

// Named RPC arguments (`name => $1`) back to the object supabase-js used to send.
function rpcArgs(text: string, values: unknown[]) {
  return Object.fromEntries([...text.matchAll(/(\w+) => \$(\d+)/g)].map(([, name, index]) => [name, values[Number(index) - 1]]))
}

async function callRpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await mocks.rpc(name, args)
  if (error)
    throw error
  return data
}

// The preflight identity statement: actor, then 2FA, then the app row, each guarded like the SQL CASEs.
async function runPreflightIdentity(text: string, values: unknown[]) {
  const [appId, orgId, check2fa] = values as [string | null, string | null, boolean]
  const userId = await callRpc('request_actor_user_id', {})
  let rejected = false
  if (userId && check2fa) {
    if (appId)
      rejected = await callRpc('reject_access_due_to_2fa_for_app', { app_id: appId }) as boolean
    else if (orgId)
      rejected = await callRpc('reject_access_due_to_2fa_for_org', { org_id: orgId }) as boolean
  }
  let app = null
  if (userId && rejected !== true && appId) {
    mocks.calls.push({ table: 'apps', text, values: [appId] })
    if (mocks.result.error)
      throw mocks.result.error
    app = Array.isArray(mocks.result.data) ? (mocks.result.data[0] ?? null) : mocks.result.data
  }
  return { user_id: userId, rejected_2fa: rejected, app }
}

// The preflight plan statement: app-scoped check, org-wide fallback, then trial RPCs only when allowed.
async function runPreflightPlan(text: string, values: unknown[]) {
  const [orgid, actions, appid] = values as [string, string[], string | null]
  mocks.events.push('plan')
  const appAllowed = text.includes('appid => p.app_id')
    ? await callRpc('is_allowed_action_org_action', { orgid, actions, appid })
    : null
  let orgAllowed = null
  if (appAllowed !== true) {
    orgAllowed = text.includes('public.is_allowed_action_org(')
      ? await callRpc('is_allowed_action_org', { orgid })
      : await callRpc('is_allowed_action_org_action', { orgid, actions })
  }
  const allowed = appAllowed === true || (appid === null && orgAllowed === true)
  if (!allowed)
    return { app_allowed: appAllowed, org_allowed: orgAllowed, is_paying: null, trial_days: null, has_credits: null }
  return {
    app_allowed: appAllowed,
    org_allowed: orgAllowed,
    is_paying: await callRpc('is_paying_org', { orgid }),
    trial_days: await callRpc('is_trial_org', { orgid }),
    has_credits: await callRpc('has_usage_credits_org', appid ? { orgid, appid } : { orgid }),
  }
}

async function runStatement(client: unknown, text: string, values: unknown[] = []): Promise<unknown> {
  if (client !== CALLER_CLIENT)
    throw new Error('caller statement ran outside withRlsContext')
  mocks.statements.push(text)
  if (text.includes('AS rejected_2fa'))
    return runPreflightIdentity(text, values)
  if (text.includes('AS has_credits'))
    return runPreflightPlan(text, values)
  const rpcName = text.match(/public\.(\w+)\(/)?.[1]
  if (rpcName) {
    const { data, error } = await mocks.rpc(rpcName, rpcArgs(text, values))
    if (error)
      throw error
    return data
  }
  // The outermost table is the last FROM (embeds are subselects before it) or the UPDATE target.
  const table = text.match(/UPDATE public\.(\w+)/)?.[1] ?? [...text.matchAll(/FROM public\.(\w+)/g)].at(-1)?.[1] ?? ''
  mocks.calls.push({ table, text, values })
  const { data, error } = mocks.result
  if (error)
    throw error
  return data
}

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: async () => ({ query: (...args: unknown[]) => mocks.adminQuery(...args) }),
  closeClient: () => {},
}))

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  apikeyPrincipal: (_c: unknown, apikey: string) => ({ kind: 'apikey', apikey }),
  withRlsContext: async (_c: unknown, principal: unknown, run: (client: unknown) => Promise<unknown>) => {
    mocks.principals.push(principal)
    return run(CALLER_CLIENT)
  },
  queryJson: async (client: unknown, text: string, values?: unknown[]) => {
    const data = await runStatement(client, text, values)
    return Array.isArray(data) ? data : data == null ? [] : [data]
  },
  queryJsonOne: async (client: unknown, text: string, values?: unknown[]) => {
    const data = await runStatement(client, text, values)
    if (/ AS value$/.test(text))
      return { value: data }
    return Array.isArray(data) ? (data[0] ?? null) : data
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
  checkPermissionsBatch: (c: unknown, checks: Array<{ permission: string, scope: unknown }>) =>
    Promise.all(checks.map(check => mocks.checkPermission(c, check.permission, check.scope))),
}))

vi.mock('../supabase/functions/_backend/utils/image_storage.ts', () => ({
  uploadImage: (_c: unknown, ...args: unknown[]) => mocks.upload(...args),
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

function requestIcon(overrides: Record<string, unknown> = {}) {
  return post('/storage/icon', {
    app_id: 'com.example.app',
    org_id: ORG_ID,
    content_base64: btoa('icon-bytes'),
    content_type: 'image/png',
    upsert: true,
    ...overrides,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.calls.length = 0
  mocks.statements.length = 0
  mocks.events.length = 0
  mocks.principals.length = 0
  mocks.result = { data: APP_ROW, error: null }
  mocks.rpcResults = { ...DEFAULT_RPC_RESULTS }
  mocks.checkPermission.mockResolvedValue(true)
  mocks.adminQuery.mockResolvedValue({ rows: [] })
  mocks.upload.mockResolvedValue('ok')
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
    expect(mocks.principals).toEqual([{ kind: 'apikey', apikey: 'test-api-key' }])
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
    mocks.result = { data: null, error: null }
    const response = await post('/preflight', { app_id: 'com.example.app', permission: 'app.read' })
    expect(response.status).toBe(404)
  })

  it('lets channel-scoped keys through without app visibility', async () => {
    mocks.result = { data: null, error: null }
    const response = await post('/preflight', { app_id: 'com.example.app', channel_id: 3, permission: 'channel.promote_bundle' })
    expect(response.status).toBe(200)
    expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), 'channel.promote_bundle', { appId: 'com.example.app', channelId: 3 })
  })

  it('keeps a 2FA-only check independent of app visibility', async () => {
    mocks.result = { data: null, error: null }
    const response = await post('/preflight', { app_id: 'com.example.app' })
    expect(response.status).toBe(200)
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

  it('needs three caller round trips for a full upload preflight', async () => {
    const response = await post('/preflight', {
      app_id: 'com.example.app',
      permission: 'app.upload_bundle',
      plan: 'all',
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
    // Identity (actor + 2FA + app row), plan status (+ trial), warnings. It used to take
    // 8 caller statements: actor, 2FA, app, plan check, paying, trial, credits, warnings.
    expect(mocks.statements).toHaveLength(3)
    expect(mocks.statements[0]).toContain('request_actor_user_id()')
    expect(mocks.statements[0]).toContain('reject_access_due_to_2fa_for_app')
    expect(mocks.statements[1]).toContain('is_trial_org')
    expect(mocks.statements[2]).toContain('get_organization_cli_warnings')
  })

  it('runs the RBAC check while the caller transaction reads the plan', async () => {
    mocks.checkPermission.mockImplementation(async () => {
      mocks.events.push('permission:start')
      await new Promise(resolve => setTimeout(resolve, 10))
      mocks.events.push('permission:end')
      return true
    })
    const response = await post('/preflight', { app_id: 'com.example.app', permission: 'app.upload_bundle', plan: 'upload' })
    expect(response.status).toBe(200)
    expect(mocks.events).toEqual(['permission:start', 'plan', 'permission:end'])
  })

  it('keeps permission_denied ahead of plan failures that ran concurrently', async () => {
    mocks.checkPermission.mockResolvedValue(false)
    mocks.rpcResults.is_allowed_action_org_action = false
    const response = await post('/preflight', { app_id: 'com.example.app', permission: 'app.upload_bundle', plan: 'upload' })
    expect(response.status).toBe(403)
    expect(await response.text()).toContain('Missing permission app.upload_bundle')

    mocks.checkPermission.mockResolvedValue(false)
    mocks.rpc.mockImplementation(async (name: string) => name === 'is_allowed_action_org_action'
      ? { data: null, error: new Error('plan lookup failed') }
      : { data: mocks.rpcResults[name] ?? null, error: null })
    const failedPlan = await post('/preflight', { app_id: 'com.example.app', permission: 'app.upload_bundle', plan: 'upload' })
    expect(failedPlan.status).toBe(403)
    expect(await failedPlan.text()).toContain('Missing permission app.upload_bundle')
  })

  it('surfaces a failed plan read once the permission passes', async () => {
    mocks.rpc.mockImplementation(async (name: string) => name === 'is_allowed_action_org_action'
      ? { data: null, error: new Error('plan lookup failed') }
      : { data: mocks.rpcResults[name] ?? null, error: null })
    const response = await post('/preflight', { app_id: 'com.example.app', permission: 'app.upload_bundle', plan: 'upload' })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Cannot check org plan status')
  })

  it('skips warnings when the plan denies and never reads the app after a 2FA rejection', async () => {
    mocks.rpcResults.is_allowed_action_org_action = false
    const denied = await post('/preflight', { app_id: 'com.example.app', plan: 'upload', cli_version: '8.0.0' })
    expect(denied.status).toBe(402)
    expect(mocks.rpc).not.toHaveBeenCalledWith('get_organization_cli_warnings', expect.anything())
    expect(mocks.rpc).not.toHaveBeenCalledWith('is_paying_org', expect.anything())

    mocks.calls.length = 0
    mocks.rpcResults.reject_access_due_to_2fa_for_app = true
    const rejected = await post('/preflight', { app_id: 'com.example.app', plan: 'upload' })
    expect(rejected.status).toBe(403)
    expect(mocks.calls.filter(call => call.table === 'apps')).toHaveLength(0)
  })

  it('returns invalid_apikey without checking 2FA when the key has no actor', async () => {
    mocks.rpcResults.request_actor_user_id = null
    const response = await post('/preflight', { app_id: 'com.example.app', permission: 'app.read' })
    expect(response.status).toBe(401)
    expect(mocks.rpc).not.toHaveBeenCalledWith('reject_access_due_to_2fa_for_app', expect.anything())
    expect(mocks.checkPermission).not.toHaveBeenCalled()
  })
})

describe('private/cli data routes', () => {
  it('gET /channels filters by app and optional name with linked versions', async () => {
    mocks.result = { data: [{ id: 1, name: 'production', version_info: { id: 7, name: '1.0.0', deleted: false } }], error: null }
    const response = await app.request('http://local/channels?app_id=com.example.app&name=production')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([{ id: 1, name: 'production', version_info: { id: 7, name: '1.0.0', deleted: false } }])
    expect(mocks.calls[0].table).toBe('channels')
    const { text, values } = mocks.calls[0]
    expect(text).toContain('av.id = ch.version) v) AS version_info')
    expect(text).toContain('av.id = ch.rollout_version) v) AS rollout_version_info')
    expect(text).toContain('ch.app_id = $1 AND ch.name = $2')
    expect(text).toContain('ORDER BY ch.name, ch.id LIMIT 1000 OFFSET 0')
    expect(values).toEqual(['com.example.app', 'production'])
    expect(mocks.principals).toEqual([{ kind: 'apikey', apikey: 'test-api-key' }])
  })

  it('gET /channels filters channels linked to a version', async () => {
    mocks.result = { data: [], error: null }
    const response = await app.request('http://local/channels?app_id=com.example.app&linked_version_id=7')
    expect(response.status).toBe(200)
    expect(mocks.calls[0].text).toContain('(ch.version = $2 OR ch.rollout_version = $2)')
    expect(mocks.calls[0].values).toEqual(['com.example.app', 7])
  })

  it('gET /channels pages past the PostgREST row cap', async () => {
    const fullPage = Array.from({ length: 1000 }, (_, index) => ({ id: index + 1, name: `c${index}` }))
    let call = 0
    mocks.result = { data: null, error: null }
    const pages = [fullPage, [{ id: 1001, name: 'last' }]]
    const original = mocks.result
    Object.defineProperty(mocks, 'result', {
      configurable: true,
      get: () => ({ data: pages[Math.min(call++, pages.length - 1)], error: null }),
      set: () => {},
    })
    try {
      const response = await app.request('http://local/channels?app_id=com.example.app')
      expect((await response.json() as unknown[]).length).toBe(1001)
      expect(mocks.calls.map(entry => entry.text.match(/LIMIT \d+ OFFSET \d+/)?.[0])).toEqual(['LIMIT 1000 OFFSET 0', 'LIMIT 1000 OFFSET 1000'])
    }
    finally {
      Object.defineProperty(mocks, 'result', { configurable: true, writable: true, enumerable: true, value: original })
    }
  })

  it('gET /channels rejects a missing app_id', async () => {
    const response = await app.request('http://local/channels')
    expect(response.status).toBe(400)
  })

  it('gET /apps/visible reports visibility', async () => {
    mocks.result = { data: { app_id: 'com.example.app', owner_org: '22222222-2222-4222-8222-222222222222' }, error: null }
    const visible = await app.request('http://local/apps/visible?app_id=com.example.app')
    expect(await visible.json()).toEqual({ visible: true, app_id: 'com.example.app', owner_org: '22222222-2222-4222-8222-222222222222' })

    mocks.result = { data: null, error: null }
    const hidden = await app.request('http://local/apps/visible?app_id=com.example.app')
    expect(await hidden.json()).toEqual({ visible: false, app_id: null, owner_org: null })
  })

  it('gET /bundles/latest includes deleted bundles', async () => {
    mocks.result = { data: { id: 9, name: '2.0.0', deleted: true, created_at: '2026-01-01' }, error: null }
    const response = await app.request('http://local/bundles/latest?app_id=com.example.app')
    expect(response.status).toBe(200)
    expect((await response.json() as { name: string }).name).toBe('2.0.0')
    expect(mocks.calls[0].text).not.toContain('deleted =')
    expect(mocks.calls[0].text).toContain('ORDER BY created_at DESC LIMIT 1')
  })

  it('pOST /bundles/deleted soft-deletes only live bundles', async () => {
    mocks.result = { data: [{ name: '1.0.0' }], error: null }
    const response = await app.request('http://local/bundles/deleted', {
      method: 'POST',
      body: JSON.stringify({ app_id: 'com.example.app', names: ['1.0.0'], deleted: true }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ updated: ['1.0.0'] })
    expect(mocks.calls[0].text).toContain('UPDATE public.app_versions SET deleted = $1 WHERE app_id = $2 AND deleted = $3 AND name = ANY($4::text[]) RETURNING name')
    expect(mocks.calls[0].values).toEqual([true, 'com.example.app', false, ['1.0.0']])
    expect(mocks.principals).toEqual([{ kind: 'apikey', apikey: 'test-api-key' }])
  })

  it('gET /manifest requires a numeric version id', async () => {
    const bad = await app.request('http://local/manifest?app_version_id=abc')
    expect(bad.status).toBe(400)

    mocks.result = { data: [{ file_name: 'index.html', file_hash: 'abc' }], error: null }
    const ok = await app.request('http://local/manifest?app_version_id=7')
    expect(await ok.json()).toEqual([{ file_name: 'index.html', file_hash: 'abc' }])
    expect(mocks.calls.at(-1)?.text).toContain('WHERE app_version_id = $1 ORDER BY id')
    expect(mocks.calls.at(-1)?.values).toEqual([7])
  })

  it('gET /manifest pages past the PostgREST row cap', async () => {
    const fullPage = Array.from({ length: 1000 }, (_, index) => ({ file_name: `f${index}`, file_hash: 'h' }))
    let call = 0
    const pages = [fullPage, fullPage, [{ file_name: 'last', file_hash: 'h' }]]
    const original = mocks.result
    Object.defineProperty(mocks, 'result', {
      configurable: true,
      get: () => ({ data: pages[Math.min(call++, pages.length - 1)], error: null }),
      set: () => {},
    })
    try {
      const response = await app.request('http://local/manifest?app_version_id=7')
      expect((await response.json() as unknown[]).length).toBe(2001)
      expect(mocks.calls.map(entry => entry.text.match(/LIMIT \d+ OFFSET \d+/)?.[0])).toEqual(['LIMIT 1000 OFFSET 0', 'LIMIT 1000 OFFSET 1000', 'LIMIT 1000 OFFSET 2000'])
    }
    finally {
      Object.defineProperty(mocks, 'result', { configurable: true, writable: true, enumerable: true, value: original })
    }
  })
})

describe('private/cli storage icon upload', () => {
  it('uploads an icon for a new app with org.create_app permission', async () => {
    const response = await requestIcon({ upsert: false })

    expect(response.status).toBe(200)
    const body = await response.json() as { path?: string }
    expect(body.path).toBe(`org/${ORG_ID}/com.example.app/icon`)
    expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), 'org.create_app', { orgId: ORG_ID })
    expect(mocks.upload).toHaveBeenCalled()
    // Existence is resolved on the connection role, not through the caller key.
    expect(mocks.adminQuery).toHaveBeenCalledWith('SELECT app_id, owner_org FROM public.apps WHERE app_id = $1', ['com.example.app'])
    expect(mocks.principals).toEqual([])
  })

  it('returns 409 conflict when upsert is false and storage already has the object', async () => {
    mocks.upload.mockResolvedValueOnce('conflict')
    const response = await requestIcon({ upsert: false })

    expect(response.status).toBe(409)
    const body = await response.json() as { conflict?: boolean, path?: string }
    expect(body.conflict).toBe(true)
    expect(body.path).toContain('com.example.app/icon')
  })

  it.each(['image/svg+xml', 'text/html', 'application/octet-stream'])('rejects non-raster content type %s', async (contentType) => {
    const response = await requestIcon({ content_type: contentType })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Icon must be a PNG, JPEG, WebP, or GIF image')
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('stores the normalized raster content type', async () => {
    const response = await requestIcon({ content_type: 'IMAGE/WEBP; charset=binary' })
    expect(response.status).toBe(200)
    expect(mocks.upload).toHaveBeenCalledWith(
      `org/${ORG_ID}/com.example.app/icon`,
      expect.any(Uint8Array),
      { contentType: 'image/webp', upsert: true },
    )
  })

  it('requires app.update_settings when the app already exists, even if hidden from the key', async () => {
    mocks.adminQuery.mockResolvedValue({ rows: [{ app_id: 'com.example.app', owner_org: ORG_ID }] })
    mocks.checkPermission.mockImplementation(async (_c: unknown, permission: string) => permission === 'org.create_app')

    const response = await requestIcon()
    expect(response.status).toBe(403)
    expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), 'app.update_settings', { appId: 'com.example.app' })
    expect(mocks.checkPermission).not.toHaveBeenCalledWith(expect.anything(), 'org.create_app', expect.anything())
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('rejects uploads when the existing app belongs to another org', async () => {
    mocks.adminQuery.mockResolvedValue({ rows: [{ app_id: 'com.example.app', owner_org: '33333333-3333-4333-8333-333333333333' }] })

    const response = await requestIcon()
    expect(response.status).toBe(403)
    expect(mocks.upload).not.toHaveBeenCalled()
  })
})
