import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app, persistObservedProgress } from '../supabase/functions/_backend/private/onboarding_progress.ts'
import { persistAppOnboarding } from '../supabase/functions/_backend/public/app/put.ts'

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  permissionPg: vi.fn(),
  from: vi.fn(),
  devices: vi.fn(),
  logs: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  update: vi.fn(),
  close: vi.fn(),
  track: vi.fn(),
  row: { onboarding: { setup: { todo_list_version: 3, steps: {} } }, created_at: '2026-09-16T00:00:00Z' } as any,
  channels: [] as any[],
  billing: { created_at: '2026-10-01T09:00:00Z', has_usage_credits: false, stripe_info: { status: 'succeeded', trial_at: '2026-11-01T12:34:56Z' } } as any,
  billingRead: vi.fn(),
  versions: [] as any[],
  archive: [] as any[],
  errors: {} as Record<string, boolean>,
  queries: [] as any[],
  auth: { authType: 'jwt', userId: '11111111-1111-4111-8111-111111111111', jwt: 'fixture', apikey: null } as any,
}))
vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({ middlewareAuth: () => async (c: Context<MiddlewareKeyVariables>, next: () => Promise<void>) => {
  c.set('auth', mocks.auth)
  await next()
} }))
vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({ checkPermission: mocks.permission, checkPermissionPg: mocks.permissionPg }))
// Caller reads run through withRlsContext / withRlsTransaction; the fake client records the
// SQL, values and principal, and answers by table like the PostgREST mock it replaces.
vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', async original => ({
  ...await original<typeof import('../supabase/functions/_backend/utils/pg_rls.ts')>(),
  withRlsTransaction: async (_pg: unknown, principal: unknown, run: (client: any) => unknown) => run(callerClient(principal)),
  withRlsContext: async (_c: unknown, principal: unknown, run: (client: any, drizzle: any) => unknown) => run(callerClient(principal), {}),
}))
vi.mock('../supabase/functions/_backend/utils/stats.ts', () => ({ readDevices: mocks.devices, readStats: mocks.logs }))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({ getPgClient: () => ({}), getDrizzleClient: () => ({ transaction: mocks.transaction }), closeClient: mocks.close }))
vi.mock('../supabase/functions/_backend/utils/utils.ts', async original => ({ ...await original<typeof import('../supabase/functions/_backend/utils/utils.ts')>(), backgroundTask: async (_c: any, task: any) => await task }))
vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({ trackPosthogEvent: mocks.track }))

async function answer(table: string, sql: string): Promise<any[]> {
  if (table === 'orgs') {
    const { data, error } = await mocks.billingRead()
    if (error)
      throw error
    return data ? [data] : []
  }
  if (mocks.errors[table])
    throw new Error('Unavailable')
  if (table === 'apps')
    return [mocks.row]
  if (table === 'channels')
    return mocks.channels
  return sql.includes('app_versions_meta') ? mocks.archive : mocks.versions
}
function callerClient(principal: unknown) {
  return {
    async query(text: string, values: unknown[] = []) {
      // queryJson wraps the statement in `WITH q AS (...) SELECT to_json(q.*) AS row FROM q`.
      const wrapped = text.match(/^WITH q AS \(([\s\S]*)\) SELECT pg_catalog\.to_json\(q\.\*\) AS row FROM q$/)
      const sql = wrapped ? wrapped[1] : text
      // The billing read embeds stripe_info in a subselect; the outer table is orgs.
      const tables = [...sql.matchAll(/FROM public\.(\w+)/g)].map(match => match[1])
      const table = tables.includes('orgs') ? 'orgs' : tables[0]
      mocks.queries.push({ table, sql, values, principal })
      mocks.from(table)
      const rows = await answer(table, sql)
      return { rows: wrapped ? rows.map(row => ({ row })) : rows }
    },
  }
}
function lockedRow(onboarding: unknown, ownerOrg = 'org') {
  mocks.execute.mockResolvedValueOnce({ rows: [{ owner_org: ownerOrg }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ onboarding, owner_org: ownerOrg }] })
    .mockResolvedValue({ rows: [] })
}
function contextFor(auth: unknown, capgkey?: string) {
  return ({
    get: (key: string) => key === 'auth' ? auth : key === 'capgkey' ? capgkey : undefined,
    env: {},
  }) as any
}
const request = (N: number, initial = false, appId = 'com.test.onboarding', includeBilling?: unknown) => app.request('http://local/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId, N, initial, includeBilling }) })

describe('onboarding progress endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.row = { onboarding: { setup: { todo_list_version: 3, steps: {} } }, created_at: '2026-09-16T00:00:00Z', owner_org: '11111111-1111-4111-8111-111111111112' }
    mocks.billing = { created_at: '2026-10-01T09:00:00Z', has_usage_credits: false, stripe_info: { status: 'succeeded', trial_at: '2026-11-01T12:34:56Z' } }
    mocks.billingRead.mockImplementation(async () => ({ data: mocks.billing, error: mocks.errors.orgs ? new Error('Unavailable') : null }))
    mocks.auth = { authType: 'jwt', userId: '11111111-1111-4111-8111-111111111111', jwt: 'fixture', apikey: null }
    mocks.channels = []
    mocks.versions = []
    mocks.archive = []
    mocks.errors = {}
    mocks.queries = []
    mocks.permission.mockResolvedValue(true)
    mocks.permissionPg.mockResolvedValue(true)
    mocks.devices.mockResolvedValue({ data: [] })
    mocks.logs.mockResolvedValue([])
    mocks.execute.mockResolvedValue({ rows: [] })
    mocks.transaction.mockImplementation(async (fn: any) => fn({ execute: mocks.execute, update: mocks.update }))
  })
  it.each([0, 1, 2, 3, 4, 5, 9])('always reads the exact app at N=%s and rotates extra checks', async (N) => {
    expect((await request(N)).status).toBe(200)
    expect(mocks.queries[0]).toMatchObject({ table: 'apps', values: ['com.test.onboarding'], principal: { kind: 'jwt', userId: mocks.auth.userId } })
    expect(mocks.queries[0].sql).toContain('SELECT onboarding, created_at, owner_org FROM public.apps WHERE app_id = $1')
    expect(mocks.queries.every(q => q.principal.kind === 'jwt')).toBe(true)
    expect(mocks.from.mock.calls.filter(call => call[0] === 'channels')).toHaveLength(N % 5 === 0 ? 1 : 0)
    expect(mocks.devices).toHaveBeenCalledTimes(N % 5 === 1 ? 1 : 0)
    expect(mocks.logs).toHaveBeenCalledTimes(N % 5 === 3 ? 1 : 0)
    expect(mocks.from.mock.calls.filter(call => call[0] === 'app_versions')).toHaveLength(N % 5 === 2 ? 2 : 0)
  })
  it('checks all four on initial load and bypasses demo logs', async () => {
    expect((await request(0, true)).status).toBe(200)
    expect(mocks.devices).toHaveBeenCalledWith(expect.anything(), { app_id: 'com.test.onboarding', limit: 1 }, false)
    expect(mocks.logs).toHaveBeenCalledWith(expect.anything(), { app_id: 'com.test.onboarding', actions: ['set'], start_date: mocks.row.created_at, limit: 10 }, false)
    expect(mocks.queries.some(q => q.sql.includes('add_code') || q.values.includes('add_code'))).toBe(false)
  })
  it.each([3, 4])('avoids the write transaction for unchanged v%s CLI progress', async (version) => {
    mocks.auth = { ...mocks.auth, authType: 'apikey', apikey: { key: 'fixture-key' } }
    const steps = { login_cli_mcp: { status: 'done' }, add_channel: { status: 'done' }, add_code: { status: 'done' }, run_device: { status: 'done' }, upload_bundle: { status: 'done' }, test_update: { status: 'done' } }
    mocks.row.onboarding = { setup: { todo_list_version: version, source: 'cli', ...(version === 4 ? { ota_todo_list_version: '1' } : {}), steps: version === 4 ? { ota: steps } : steps } }
    mocks.channels = [{ id: 'channel' }]
    const result = await (await request(0, true)).json()
    expect(result).toEqual({ onboarding: mocks.row.onboarding, hasChannel: true, checkErrors: [] })
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.permissionPg).not.toHaveBeenCalled()
    expect(mocks.devices).not.toHaveBeenCalled()
    expect(mocks.logs).not.toHaveBeenCalled()
  })
  it.each([3, 4])('infers v%s add_code on read once the update was delivered, like the todo refresh cron', async (version) => {
    const steps = { test_update: { status: 'done' }, add_code: { status: 'pending' } }
    mocks.row.onboarding = { setup: { todo_list_version: version, ...(version === 4 ? { ota_todo_list_version: '1', paths: ['ota'] } : {}), steps: version === 4 ? { ota: steps } : steps } }
    lockedRow(mocks.row.onboarding)
    const result = await (await request(4)).json() as any
    const saved = version === 4 ? result.onboarding.setup.steps.ota : result.onboarding.setup.steps
    expect(saved.add_code).toMatchObject({ status: 'done', annotation: 'inferred_from_test_update', annotation_type: 'note' })
    expect(mocks.transaction).toHaveBeenCalledOnce()
  })
  it('infers add_code in the same read that first observes the delivered update', async () => {
    mocks.logs.mockResolvedValue([{ action: 'set', device_id: 'device', version_name: '1.0' }])
    mocks.versions = [{ id: 1 }]
    lockedRow(mocks.row.onboarding)
    const steps = (await (await request(3)).json() as any).onboarding.setup.steps
    expect(steps.test_update.status).toBe('done')
    expect(steps.add_code).toMatchObject({ status: 'done', annotation: 'inferred_from_test_update' })
  })
  it('skips the locked no-op write when a read-only caller sees a delivered update', async () => {
    mocks.row.onboarding = { setup: { todo_list_version: 3, steps: { test_update: { status: 'done' } } } }
    mocks.permission.mockImplementation(async (_c, permission) => !['app.update_settings', 'org.create_app'].includes(permission))
    expect((await (await request(4)).json() as any).onboarding).toEqual(mocks.row.onboarding)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it('avoids the write transaction when every pending observation is absent', async () => {
    expect((await request(0, true)).status).toBe(200)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it('persists a source-only promotion when CLI login was already done', async () => {
    mocks.auth = { ...mocks.auth, authType: 'apikey', apikey: { key: 'fixture-key' } }
    mocks.row.onboarding = { setup: { todo_list_version: 3, source: 'ai', steps: { login_cli_mcp: { status: 'done', at: 'old' } } } }
    lockedRow(mocks.row.onboarding)
    const result = await (await request(4)).json() as any
    expect(result.onboarding.setup.source).toBe('cli')
    expect(result.onboarding.setup.steps.login_cli_mcp).toEqual({ status: 'done', at: 'old' })
    expect(mocks.transaction).toHaveBeenCalledOnce()
  })
  it('still persists source promotion and deleted channels after the preflight', async () => {
    mocks.auth = { ...mocks.auth, authType: 'apikey', apikey: { key: 'fixture-key' } }
    mocks.row.onboarding = { setup: { todo_list_version: 3, source: 'ai', steps: { login_cli_mcp: { status: 'done', at: 'old' }, add_channel: { status: 'done' } } } }
    lockedRow(mocks.row.onboarding)
    const result = await (await request(0)).json() as any
    expect(result.onboarding.setup.source).toBe('cli')
    expect(result.onboarding.setup.steps.login_cli_mcp).toEqual({ status: 'done', at: 'old' })
    expect(result.onboarding.setup.steps.add_channel).toBeUndefined()
    expect(mocks.transaction).toHaveBeenCalledOnce()
  })
  it('rechecks the latest locked row when a local report wins the race', async () => {
    mocks.channels = [{ id: 'channel' }]
    const latest = { setup: { todo_list_version: 3, source: 'cli', steps: { add_channel: { status: 'done', at: 'concurrent' }, add_code: { status: 'done' } } } }
    lockedRow(latest)
    expect((await request(0)).status).toBe(200)
    expect(mocks.transaction).toHaveBeenCalledOnce()
    expect(mocks.execute).toHaveBeenCalledTimes(3) // Locks only; the concurrent report already applied this observation.
    expect(mocks.track).not.toHaveBeenCalled()
  })
  it.each([undefined, false])('omits billing and its reads when includeBilling=%s', async (includeBilling) => {
    const result = await (await request(4, false, undefined, includeBilling)).json()
    expect(result).not.toHaveProperty('billing')
    expect(mocks.from).not.toHaveBeenCalledWith('orgs')
    expect(mocks.permission.mock.calls.some(call => call[1] === 'org.read_billing')).toBe(false)
  })
  it.each([
    ['succeeded', true, true, true],
    ['canceled', false, false, false],
    ['canceled', true, false, false],
    // Churned customer: paid once, no longer paying.
    ['canceled', false, false, true],
    [null, false, false, false],
  ])('returns CLI billing fields for status %s (credits=%s, paying=%s, paid=%s)', async (status, hasCredits, isPaying, hasPaid) => {
    mocks.billing = { created_at: '2026-10-01T09:00:00Z', has_usage_credits: hasCredits, stripe_info: { status, trial_at: '2026-11-01T12:34:56Z', paid_at: hasPaid ? '2026-10-02T00:00:00Z' : null } }
    const response = await request(4, false, undefined, true)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect((await response.json() as any).billing).toEqual({ status: 'available', orgId: mocks.row.owner_org, orgCreatedAt: '2026-10-01T09:00:00Z', trialEndsAt: '2026-11-01T12:34:56Z', hasPaid, isPaying, hasCredits })
    expect(mocks.permission).toHaveBeenCalledWith(expect.anything(), 'org.read_billing', { orgId: mocks.row.owner_org })
    expect(mocks.queries.at(-1)).toMatchObject({ table: 'orgs', values: [mocks.row.owner_org], principal: { kind: 'jwt', userId: mocks.auth.userId } })
    expect(mocks.queries.at(-1).sql).toMatch(/SELECT o\.created_at, o\.has_usage_credits,[\s\S]*si\.status, si\.trial_at, si\.paid_at FROM public\.stripe_info si WHERE si\.customer_id = o\.customer_id[\s\S]*WHERE o\.id = \$1/)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it('returns no trial explicitly instead of inventing an expiry', async () => {
    mocks.billing.stripe_info.trial_at = null
    expect((await (await request(4, false, undefined, true)).json() as any).billing.trialEndsAt).toBeNull()
  })
  it.each(['denied', 'permission-error', 'query-error', 'throw', 'missing-org', 'missing-stripe'])('keeps progress usable when billing is %s', async (failure) => {
    if (failure === 'denied')
      mocks.permission.mockImplementation(async (_c, permission) => permission !== 'org.read_billing')
    if (failure === 'permission-error') {
      mocks.permission.mockImplementation(async (_c, permission) => {
        if (permission === 'org.read_billing')
          throw new Error('Unavailable')
        return true
      })
    }
    if (failure === 'query-error')
      mocks.errors.orgs = true
    if (failure === 'throw')
      mocks.billingRead.mockRejectedValue(new Error('Unavailable'))
    if (failure === 'missing-org')
      mocks.billing = null
    if (failure === 'missing-stripe')
      mocks.billing.stripe_info = null
    const response = await request(4, false, undefined, true)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ onboarding: mocks.row.onboarding, checkErrors: [], billing: { status: 'unavailable' } })
    if (failure === 'denied' || failure === 'permission-error')
      expect(mocks.from).not.toHaveBeenCalledWith('orgs')
  })
  it('starts billing while progress is still gathering observations', async () => {
    let finishDevices!: (value: any) => void
    mocks.devices.mockImplementation(() => new Promise((resolve) => {
      finishDevices = resolve
    }))
    const response = request(0, true, undefined, true)
    await vi.waitFor(() => expect(mocks.billingRead).toHaveBeenCalledOnce())
    expect(mocks.devices).toHaveBeenCalledOnce()
    finishDevices({ data: [] })
    expect((await response).status).toBe(200)
  })
  it('persists progress without waiting for the optional billing read', async () => {
    let finishBilling!: (value: any) => void
    mocks.billingRead.mockImplementation(() => new Promise((resolve) => {
      finishBilling = resolve
    }))
    mocks.devices.mockResolvedValue({ data: [{ device_id: 'device' }] })
    lockedRow(mocks.row.onboarding)
    const response = request(1, false, undefined, true)
    await vi.waitFor(() => expect(mocks.transaction).toHaveBeenCalledOnce())
    expect(mocks.billingRead).toHaveBeenCalledOnce()
    finishBilling({ data: mocks.billing, error: null })
    expect((await (await response).json() as any).onboarding.setup.steps.run_device.status).toBe('done')
  })
  it.each(['true', 1, null])('rejects malformed includeBilling=%s before reading data', async (value) => {
    expect((await request(4, false, undefined, value)).status).toBe(400)
    expect(mocks.from).not.toHaveBeenCalled()
  })
  it('retains progress and channel state when a check fails', async () => {
    mocks.errors.channels = true
    const result = await (await request(0)).json()
    expect(result).toEqual({ onboarding: mocks.row.onboarding, checkErrors: ['add_channel'] })
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it('requires set for a real uploaded version, never download_complete or builtin', async () => {
    mocks.logs.mockResolvedValue([{ action: 'download_complete', device_id: 'device', version_name: '1.0' }, { action: 'set', device_id: 'device', version_name: 'builtin' }])
    await request(3)
    expect(mocks.from).not.toHaveBeenCalledWith('app_versions')
    mocks.logs.mockResolvedValue([{ action: 'set', device_id: 'device', version_name: '1.0' }])
    await request(3)
    expect(mocks.queries.at(-1)).toMatchObject({ table: 'app_versions', values: ['com.test.onboarding', ['1.0']] })
    expect(mocks.queries.at(-1).sql).toContain('name = ANY($2::text[])')
  })
  it('does not infer new milestones for a control app', async () => {
    mocks.row.onboarding.setup.todo_list_version = 2
    await request(0, true)
    expect(mocks.devices).not.toHaveBeenCalled()
    expect(mocks.logs).not.toHaveBeenCalled()
    expect(mocks.from).not.toHaveBeenCalledWith('app_versions')
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it.each([3, 4])('returns v%s CLI start as done in the same API-key request with read-only app access', async (todoListVersion) => {
    mocks.auth = { authType: 'apikey', userId: 'other-user', apikey: { key: 'fixture-key' } }
    mocks.row.onboarding = {
      created_by_user_id: 'creator',
      setup: {
        todo_list_version: todoListVersion,
        source: 'ai',
        ...(todoListVersion === 4 ? { ota_todo_list_version: '1', paths: ['ota'] } : {}),
        steps: todoListVersion === 4 ? { ota: { login_cli_mcp: { status: 'pending' }, add_channel: { status: 'pending' } } } : {},
      },
    }
    lockedRow(mocks.row.onboarding)
    mocks.permissionPg.mockImplementation(async (_c, permission) => permission === 'app.read')

    const response = await request(4)
    const result = await response.json() as any
    const steps = todoListVersion === 4 ? result.onboarding.setup.steps.ota : result.onboarding.setup.steps
    expect(steps.login_cli_mcp.status).toBe('done')
    expect(mocks.queries[0].principal).toEqual({ kind: 'apikey', apikey: 'fixture-key' })
    if (todoListVersion === 4) {
      expect(steps.add_channel).toEqual({ status: 'pending' })
      expect(result.onboarding.setup.steps.login_cli_mcp).toBeUndefined()
      expect(result.onboarding.setup.paths).toEqual(['ota'])
    }
    else {
      expect(Object.keys(steps)).toEqual(['login_cli_mcp'])
    }
    expect(result.onboarding.setup.source).toBe('cli')
    expect(mocks.permission).toHaveBeenCalledWith(expect.anything(), 'app.read', { appId: 'com.test.onboarding' })
    expect(mocks.permissionPg).toHaveBeenCalledWith(expect.anything(), 'app.read', { appId: 'com.test.onboarding' }, expect.anything(), 'other-user', 'fixture-key')
    expect(mocks.execute).toHaveBeenCalledTimes(5)
  })
  it('keeps v4 channel progress pending when an API key has read-only app access', async () => {
    mocks.auth = { authType: 'apikey', userId: 'other-user', apikey: { key: 'fixture-key' } }
    mocks.row.onboarding = { setup: { todo_list_version: 4, ota_todo_list_version: '1', paths: ['ota'], steps: { ota: { login_cli_mcp: { status: 'pending' }, add_channel: { status: 'pending' } } } } }
    mocks.channels = [{ id: 'channel' }]
    lockedRow(mocks.row.onboarding)
    mocks.permissionPg.mockImplementation(async (_c, permission) => permission === 'app.read')

    const result = await (await request(0)).json() as any
    expect(result.onboarding.setup.steps.ota.login_cli_mcp.status).toBe('done')
    expect(result.onboarding.setup.steps.ota.add_channel.status).toBe('pending')
  })
  it('does not mark CLI start for JWT requests, revoked API keys, or v2 apps', async () => {
    mocks.row.onboarding = { created_by_user_id: 'creator', setup: { todo_list_version: 3, steps: {} } }
    expect(((await (await request(4)).json()) as any).onboarding).toEqual(mocks.row.onboarding)
    expect(mocks.execute).not.toHaveBeenCalled()

    mocks.auth = { authType: 'apikey', userId: 'other-user', apikey: { key: 'other-key' } }
    mocks.from.mockClear()
    mocks.permission.mockResolvedValue(false)
    expect((await request(4)).status).toBe(403)
    expect(mocks.from).not.toHaveBeenCalled()
    expect(mocks.execute).not.toHaveBeenCalled()

    mocks.permission.mockResolvedValue(true)
    lockedRow(mocks.row.onboarding)
    mocks.permissionPg.mockResolvedValue(false)
    expect(((await (await request(4)).json()) as any).onboarding).toEqual(mocks.row.onboarding)
    expect(mocks.execute).toHaveBeenCalledTimes(3)

    mocks.execute.mockClear()
    mocks.auth = { authType: 'apikey', userId: 'creator', apikey: { key: 'creator-key' } }
    mocks.row.onboarding.setup.todo_list_version = 2
    expect(((await (await request(4)).json()) as any).onboarding).toEqual(mocks.row.onboarding)
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it.each(['2', 1])('does not update unsupported v4 OTA version %s', async (otaVersion) => {
    mocks.auth = { authType: 'apikey', userId: 'other-user', apikey: { key: 'fixture-key' } }
    mocks.row.onboarding = { setup: { todo_list_version: 4, ota_todo_list_version: otaVersion, steps: { ota: { login_cli_mcp: { status: 'pending' } } } } }
    const result = await (await request(4)).json() as any
    expect(result.onboarding).toEqual(mocks.row.onboarding)
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it('does not expose app existence or logs/devices without permission', async () => {
    mocks.permission.mockResolvedValue(false)
    expect((await request(0)).status).toBe(403)
    expect(mocks.from).not.toHaveBeenCalled()
    mocks.permission.mockImplementation(async (_c, permission) => permission === 'app.read')
    await request(0, true)
    expect(mocks.devices).not.toHaveBeenCalled()
    expect(mocks.logs).not.toHaveBeenCalled()
  })
  it.each([-1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1])('rejects invalid N=%s before reading data', async (N) => {
    expect((await request(N as number)).status).toBe(400)
    expect(mocks.from).not.toHaveBeenCalled()
  })
  it('merges observations with the locked current row, preserving init app-ready progress', async () => {
    const onboarding = { setup: { todo_list_version: 3, source: 'cli', steps: { add_code: { status: 'done' }, login_cli_mcp: { status: 'done' } } } }
    lockedRow(onboarding)
    const context = { get: (key: string) => key === 'auth' ? { userId: 'user', authType: 'jwt' } : undefined, env: {} } as any
    const result = await persistObservedProgress(context, 'com.test.onboarding', { run_device: true }) as any
    expect(result.setup.steps.add_code.status).toBe('done')
    expect(result.setup.steps.run_device.status).toBe('done')
    expect(result.setup.steps.test_update).toBeUndefined()
    expect(mocks.close).toHaveBeenCalledOnce()
  })
  it('unchecks a deleted channel despite a saved done report', async () => {
    const onboarding = { setup: { todo_list_version: 3, steps: { add_channel: { status: 'done' } } } }
    lockedRow(onboarding)
    const context = contextFor({ userId: 'user', authType: 'jwt' })
    expect((await persistObservedProgress(context, 'com.test.onboarding', { add_channel: false }) as any).setup.steps.add_channel).toBeUndefined()
  })
  it.each(['app.update_settings', 'org.create_app'])('allows every requested observation through normal %s permission', async (permission) => {
    lockedRow(mocks.row.onboarding)
    mocks.permissionPg.mockImplementation(async (_c, requested) => requested === permission)
    const result = await persistObservedProgress(contextFor({ userId: 'user', authType: 'apikey', apikey: { key: 'fixture-key' } }), 'com.test.onboarding', { login_cli_mcp: true, add_channel: true, run_device: true, upload_bundle: true, test_update: true }) as any
    // add_code is inferred from the delivered update.
    expect(Object.values(result.setup.steps).map((step: any) => step.status)).toEqual(Array.from({ length: 6 }).fill('done'))
    expect(result.setup.source).toBe('cli')
    expect(mocks.permissionPg.mock.calls.map(call => call[1])).toEqual(permission === 'app.update_settings' ? ['app.update_settings'] : ['app.update_settings', 'org.create_app'])
  })
  it('limits the login override to login across a mixed observation request', async () => {
    lockedRow(mocks.row.onboarding)
    mocks.permissionPg.mockImplementation(async (_c, permission) => permission === 'app.read')
    const result = await persistObservedProgress(contextFor({ userId: 'user', authType: 'apikey', apikey: { key: 'fixture-key' } }), 'com.test.onboarding', { login_cli_mcp: true, add_channel: true, run_device: true, upload_bundle: true, test_update: true }) as any
    expect(Object.keys(result.setup.steps)).toEqual(['login_cli_mcp'])
    expect(mocks.track).toHaveBeenCalledOnce()
  })
  it('emits observed history after commit with the same timestamp, and never on a commit failure', async () => {
    lockedRow(mocks.row.onboarding)
    let committed = false
    mocks.transaction.mockImplementation(async (callback: any) => {
      const result = await callback({ execute: mocks.execute })
      expect(mocks.track).not.toHaveBeenCalled()
      committed = true
      return result
    })
    mocks.track.mockImplementation(async () => expect(committed).toBe(true))
    const result = await persistObservedProgress(contextFor(mocks.auth), 'com.test.onboarding', { run_device: true }) as any
    expect(mocks.track.mock.calls[0][1]).toMatchObject({ timestamp: result.setup.updated_at, groups: { organization: 'org' }, nonPersonTags: { step_id: 'run_device', history_length: 1, onboarding_source: 'manual', todo_list_version: 3 } })
    expect(result.setup.steps.run_device).toEqual({ status: 'done', at: result.setup.updated_at, update_history: [{ status: 'done', at: result.setup.updated_at }] })
    mocks.track.mockReset()
    lockedRow(mocks.row.onboarding)
    mocks.transaction.mockImplementation(async (callback: any) => {
      await callback({ execute: mocks.execute })
      throw new Error('commit failed')
    })
    await expect(persistObservedProgress(contextFor(mocks.auth), 'com.test.onboarding', { run_device: true })).rejects.toThrow('commit failed')
    expect(mocks.track).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledTimes(2)
  })
  it('preserves skipped outcomes and promotes the login source without rewriting its timestamp', async () => {
    lockedRow({ setup: { todo_list_version: 3, outcome: 'skipped', steps: {} } })
    expect(await persistObservedProgress(contextFor(mocks.auth), 'com.test.onboarding', { run_device: true })).toBeUndefined()
    expect(mocks.execute).toHaveBeenCalledTimes(3)
    const step = { status: 'done', at: 'old', update_history: [{ status: 'done', at: 'old' }] }
    lockedRow({ setup: { todo_list_version: 3, source: 'ai', steps: { login_cli_mcp: step } } })
    const result = await persistObservedProgress(contextFor(mocks.auth), 'com.test.onboarding', { login_cli_mcp: true }) as any
    expect(result.setup.source).toBe('cli')
    expect(result.setup.steps.login_cli_mcp).toEqual(step)
    expect(mocks.track).not.toHaveBeenCalled()
  })
  it('returns a deleted v4 channel to pending without removing its OTA step', async () => {
    const onboarding = { setup: { todo_list_version: 4, ota_todo_list_version: '1', paths: ['ota'], steps: { ota: { add_channel: { status: 'done' }, add_code: { status: 'pending' } } } } }
    lockedRow(onboarding)
    const context = contextFor({ userId: 'user', authType: 'jwt' })
    const result = await persistObservedProgress(context, 'com.test.onboarding', { add_channel: false }) as any
    expect(result.setup.steps.ota.add_channel).toEqual({ status: 'pending' })
    expect(result.setup.steps.ota.add_code).toEqual({ status: 'pending' })
    expect(result.setup.paths).toEqual(['ota'])
  })
  it('does not rewrite a v4 channel step that is already pending', async () => {
    const onboarding = { setup: { todo_list_version: 4, ota_todo_list_version: '1', paths: ['ota'], steps: { ota: { add_channel: { status: 'pending' } } } } }
    lockedRow(onboarding)
    expect(await persistObservedProgress(contextFor({ userId: 'user', authType: 'jwt' }), 'com.test.onboarding', { add_channel: false })).toBeUndefined()
    expect(mocks.execute).toHaveBeenCalledTimes(3)
  })
  it('records observed v4 milestones in the OTA path', async () => {
    const onboarding = { setup: { todo_list_version: 4, ota_todo_list_version: '1', steps: { ota: {} } } }
    lockedRow(onboarding)
    const result = await persistObservedProgress(contextFor({ userId: 'user', authType: 'jwt' }), 'com.test.onboarding', { run_device: true }) as any
    expect(result.setup.steps.ota.run_device.status).toBe('done')
    expect(result.setup.steps.run_device).toBeUndefined()
  })
  it('preserves the request key for hashed RBAC keys on both write-permission paths', async () => {
    lockedRow(mocks.row.onboarding)
    mocks.permissionPg.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const auth = { userId: 'user', authType: 'apikey', apikey: { key: null, rbac_id: 'rbac-key' } }
    const result = await persistObservedProgress(contextFor(auth, 'fixture-hashed-key'), 'com.test.onboarding', { run_device: true }) as any
    expect(result.setup.steps.run_device.status).toBe('done')
    expect(mocks.permissionPg).toHaveBeenNthCalledWith(1, expect.anything(), 'app.update_settings', { appId: 'com.test.onboarding' }, expect.anything(), 'user', 'fixture-hashed-key')
    expect(mocks.permissionPg).toHaveBeenNthCalledWith(2, expect.anything(), 'org.create_app', { orgId: 'org' }, expect.anything(), 'user', 'fixture-hashed-key')
  })
  it('does not persist observed progress after permission is revoked', async () => {
    lockedRow(mocks.row.onboarding)
    mocks.permissionPg.mockResolvedValue(false)
    expect(await persistObservedProgress(contextFor({ userId: 'user', authType: 'jwt' }), 'com.test.onboarding', { run_device: true })).toBeUndefined()
    expect(mocks.execute).toHaveBeenCalledTimes(3)
  })
  it('rejects CLI progress under the locked current permission state before any merge or write', async () => {
    lockedRow(mocks.row.onboarding)
    mocks.permissionPg.mockResolvedValue(false)
    const context = contextFor({ userId: 'user', authType: 'apikey', apikey: { key: null, rbac_id: 'rbac-key' } }, 'fixture-hashed-key')
    await expect(persistAppOnboarding(context, 'com.test.onboarding', { steps: { add_code: { status: 'done' } } }, { user_id: 'user', key: null } as any)).rejects.toMatchObject({ status: 401 })
    expect(mocks.permissionPg.mock.calls.every(call => call[5] === 'fixture-hashed-key')).toBe(true)
    expect(mocks.execute).toHaveBeenCalledTimes(3)
    expect(mocks.close).toHaveBeenCalledOnce()
  })
  it('retries CLI progress after an organization transfer and authorizes its new scope', async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ owner_org: 'original-org' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ onboarding: mocks.row.onboarding, owner_org: 'new-org' }] })
    lockedRow(mocks.row.onboarding, 'new-org')
    const onboarding = { setup: { todo_list_version: 3, steps: { add_code: { status: 'done' } } } }
    const row = { app_id: 'com.test.onboarding', owner_org: 'new-org', onboarding }
    mocks.execute.mockResolvedValueOnce({ rows: [{ onboarding }] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ completed: false }] })
      .mockResolvedValueOnce({ rows: [row] })
    mocks.permissionPg.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const result = await persistAppOnboarding(contextFor({ userId: 'user', authType: 'jwt' }), row.app_id, { steps: { add_code: { status: 'done' } } }, { user_id: 'user', key: null } as any)
    expect(result?.app).toMatchObject(row)
    expect(mocks.transaction).toHaveBeenCalledTimes(2)
    expect(mocks.permissionPg).toHaveBeenNthCalledWith(2, expect.anything(), 'org.create_app', { orgId: 'new-org' }, expect.anything(), 'user', null)
  })
  it('retries polled observations after an organization transfer', async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ owner_org: 'original-org' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ onboarding: mocks.row.onboarding, owner_org: 'new-org' }] })
    lockedRow(mocks.row.onboarding, 'new-org')
    mocks.permissionPg.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const result = await persistObservedProgress(contextFor({ userId: 'user', authType: 'jwt' }), 'com.test.onboarding', { run_device: true }) as any
    expect(result.setup.steps.run_device.status).toBe('done')
    expect(mocks.transaction).toHaveBeenCalledTimes(2)
    expect(mocks.permissionPg.mock.calls[1][2]).toEqual({ orgId: 'new-org' })
  })
  it('bounds transfer retries and reports a retryable conflict without writing', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      mocks.execute.mockResolvedValueOnce({ rows: [{ owner_org: `org-${attempt}` }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ onboarding: mocks.row.onboarding, owner_org: `org-${attempt + 1}` }] })
    }
    await expect(persistAppOnboarding(contextFor({ userId: 'user', authType: 'jwt' }), 'com.test.onboarding', undefined, { user_id: 'user', key: null } as any)).rejects.toMatchObject({ status: 409 })
    expect(mocks.transaction).toHaveBeenCalledTimes(3)
    expect(mocks.execute).toHaveBeenCalledTimes(9)
    expect(mocks.permissionPg).not.toHaveBeenCalled()
  })
  it('keeps a genuinely missing app distinct from a transfer', async () => {
    expect(await persistAppOnboarding(contextFor({ userId: 'user', authType: 'jwt' }), 'com.test.onboarding', undefined, { user_id: 'user', key: null } as any)).toBeUndefined()
    expect(mocks.transaction).toHaveBeenCalledOnce()
  })
  it('rejects combined settings and progress before either write when settings permission is revoked', async () => {
    lockedRow(mocks.row.onboarding)
    mocks.permissionPg.mockResolvedValue(false)
    await expect(persistAppOnboarding(contextFor({ userId: 'user', authType: 'jwt' }), 'com.test.onboarding', { steps: { add_code: { status: 'done' } } }, { user_id: 'user', key: null } as any, undefined, false, { name: 'Changed' })).rejects.toMatchObject({ status: 401 })
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.execute).toHaveBeenCalledTimes(3)
    expect(mocks.permissionPg).toHaveBeenCalledOnce()
  })
})
