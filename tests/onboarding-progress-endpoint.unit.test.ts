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
vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({ supabaseWithAuth: () => ({ from: mocks.from }) }))
vi.mock('../supabase/functions/_backend/utils/stats.ts', () => ({ readDevices: mocks.devices, readStats: mocks.logs }))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({ getPgClient: () => ({}), getDrizzleClient: () => ({ transaction: mocks.transaction }), closeClient: mocks.close }))
vi.mock('../supabase/functions/_backend/utils/utils.ts', async original => ({ ...await original<typeof import('../supabase/functions/_backend/utils/utils.ts')>(), backgroundTask: async (_c: any, task: any) => await task }))
vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({ trackPosthogEvent: mocks.track }))

function query(table: string) {
  const calls: any[] = []
  mocks.queries.push({ table, calls })
  const builder: any = {}
  for (const method of ['select', 'eq', 'neq', 'not', 'or', 'gt', 'in', 'limit']) {
    builder[method] = (...args: any[]) => {
      calls.push([method, ...args])
      return builder
    }
  }
  builder.single = async () => ({ data: mocks.row, error: mocks.errors[table] ? new Error('Unavailable') : null })
  builder.then = (resolve: any, reject: any) => Promise.resolve({
    data: table === 'channels' ? mocks.channels : calls.some(call => String(call[1]).includes('!inner')) ? mocks.archive : mocks.versions,
    error: mocks.errors[table] ? new Error('Unavailable') : null,
  }).then(resolve, reject)
  return builder
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
const request = (N: number, initial = false, appId = 'com.test.onboarding', client?: 'cli') => app.request('http://local/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId, N, initial, ...(client ? { client } : {}) }) })

describe('onboarding progress endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.row = { onboarding: { setup: { todo_list_version: 3, steps: {} } }, created_at: '2026-09-16T00:00:00Z' }
    mocks.auth = { authType: 'jwt', userId: '11111111-1111-4111-8111-111111111111', jwt: 'fixture', apikey: null }
    mocks.channels = []
    mocks.versions = []
    mocks.archive = []
    mocks.errors = {}
    mocks.queries = []
    mocks.from.mockImplementation(query)
    mocks.permission.mockResolvedValue(true)
    mocks.permissionPg.mockResolvedValue(true)
    mocks.devices.mockResolvedValue({ data: [] })
    mocks.logs.mockResolvedValue([])
    mocks.execute.mockResolvedValue({ rows: [] })
    mocks.transaction.mockImplementation(async (fn: any) => fn({ execute: mocks.execute, update: mocks.update }))
  })
  it.each([0, 1, 2, 3, 4, 5, 9])('always reads the exact app at N=%s and rotates extra checks', async (N) => {
    expect((await request(N)).status).toBe(200)
    expect(mocks.queries[0]).toMatchObject({ table: 'apps', calls: [['select', 'onboarding, created_at'], ['eq', 'app_id', 'com.test.onboarding']] })
    expect(mocks.from.mock.calls.filter(call => call[0] === 'channels')).toHaveLength(N % 5 === 0 ? 1 : 0)
    expect(mocks.devices).toHaveBeenCalledTimes(N % 5 === 1 ? 1 : 0)
    expect(mocks.logs).toHaveBeenCalledTimes(N % 5 === 3 ? 1 : 0)
    expect(mocks.from.mock.calls.filter(call => call[0] === 'app_versions')).toHaveLength(N % 5 === 2 ? 2 : 0)
  })
  it('checks all four on initial load and bypasses demo logs', async () => {
    expect((await request(0, true)).status).toBe(200)
    expect(mocks.devices).toHaveBeenCalledWith(expect.anything(), { app_id: 'com.test.onboarding', limit: 1 }, false)
    expect(mocks.logs).toHaveBeenCalledWith(expect.anything(), { app_id: 'com.test.onboarding', actions: ['set'], start_date: mocks.row.created_at, limit: 10 }, false)
    expect(mocks.queries.some(q => q.calls.some((call: any[]) => call.includes('add_code')))).toBe(false)
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
    expect(mocks.queries.at(-1).calls).toContainEqual(['in', 'name', ['1.0']])
    expect(mocks.queries.at(-1).calls).toContainEqual(['eq', 'app_id', 'com.test.onboarding'])
  })
  it('does not infer new milestones for a control app', async () => {
    mocks.row.onboarding.setup.todo_list_version = 2
    await request(0, true)
    expect(mocks.devices).not.toHaveBeenCalled()
    expect(mocks.logs).not.toHaveBeenCalled()
    expect(mocks.from).not.toHaveBeenCalledWith('app_versions')
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it('returns v3 CLI start as done in the same API-key request, even with read-only app access', async () => {
    mocks.auth = { authType: 'apikey', userId: 'creator', apikey: { key: null } }
    mocks.row.onboarding = { created_by_user_id: 'creator', setup: { todo_list_version: 3, source: 'ai', steps: {} } }
    lockedRow(mocks.row.onboarding)
    mocks.permissionPg.mockImplementation(async (_c, permission) => permission === 'app.read')

    const response = await request(0, true, 'com.test.onboarding', 'cli')
    const result = await response.json() as any
    expect(result.onboarding.setup.steps.login_cli_mcp.status).toBe('done')
    expect(Object.keys(result.onboarding.setup.steps)).toEqual(['login_cli_mcp'])
    expect(result.onboarding.setup.source).toBe('cli')
    expect(mocks.permissionPg).toHaveBeenCalledWith(expect.anything(), 'app.read', { appId: 'com.test.onboarding' }, expect.anything(), 'creator', null)
    expect(mocks.execute).toHaveBeenCalledTimes(5)
  })
  it('does not mark CLI start for JWT requests, unmarked API-key requests, or another app creator', async () => {
    mocks.row.onboarding = { created_by_user_id: 'creator', setup: { todo_list_version: 3, steps: {} } }
    expect(((await (await request(4, false, 'com.test.onboarding', 'cli')).json()) as any).onboarding).toEqual(mocks.row.onboarding)
    expect(mocks.execute).not.toHaveBeenCalled()

    mocks.auth = { authType: 'apikey', userId: 'creator', apikey: { key: 'creator-key' } }
    expect(((await (await request(4)).json()) as any).onboarding).toEqual(mocks.row.onboarding)
    expect(mocks.execute).not.toHaveBeenCalled()

    mocks.auth = { authType: 'apikey', userId: 'other-user', apikey: { key: 'other-key' } }
    lockedRow(mocks.row.onboarding)
    expect(((await (await request(4, false, 'com.test.onboarding', 'cli')).json()) as any).onboarding).toEqual(mocks.row.onboarding)
    expect(mocks.execute).toHaveBeenCalledTimes(3)

    mocks.execute.mockClear()
    mocks.auth = { authType: 'apikey', userId: 'creator', apikey: { key: 'creator-key' } }
    mocks.row.onboarding.setup.todo_list_version = 2
    expect(((await (await request(4, false, 'com.test.onboarding', 'cli')).json()) as any).onboarding).toEqual(mocks.row.onboarding)
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
