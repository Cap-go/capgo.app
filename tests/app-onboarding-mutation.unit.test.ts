import type { Context } from 'hono'
import type { AuthInfo, MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { markAppOnboardingLoginFromTracking } from '../supabase/functions/_backend/utils/app_onboarding_login.ts'
import { persistAuthorizedOnboardingMutation, persistLockedAuthorizedOnboardingMutation } from '../supabase/functions/_backend/utils/appOnboardingMutation.ts'

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  getPool: vi.fn(),
  getDrizzle: vi.fn(),
  close: vi.fn(),
  track: vi.fn(),
  log: vi.fn(),
}))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({ getPgClient: mocks.getPool, getDrizzleClient: mocks.getDrizzle, closeClient: mocks.close }))
vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({ checkPermissionPg: mocks.permission }))
vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({ trackPosthogEvent: mocks.track }))
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({ cloudlogErr: mocks.log, serializeError: (error: unknown) => error }))
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({ backgroundTask: async (_c: unknown, task: Promise<unknown>) => await task }))

const appId = 'com.test.mutation'
const auth = { userId: 'fixture-user', authType: 'apikey', apikey: { key: 'fixture-key' }, jwt: null } as AuthInfo
const context = (identity = auth) => ({ get: (key: string) => key === 'auth' ? identity : key === 'capgkey' ? 'fallback-key' : undefined }) as Context<MiddlewareKeyVariables>
const tx = { execute: mocks.execute }
const pool = {}
const dialect = new PgDialect()
const overrides = { 'ota.login_cli_mcp': { permission: 'app.read' as const, authType: 'apikey' as const } }
const buildPatch = () => ({ steps: { add_channel: { status: 'done' as const } } })
let rows: Array<{ app_id: string, owner_org: string, onboarding: any }>
let statements: Array<{ sql: string, params: unknown[] }>
let order: string[]

beforeEach(() => {
  vi.resetAllMocks()
  rows = [{ app_id: appId, owner_org: 'fixture-org', onboarding: { setup: { todo_list_version: 3, source: 'manual', steps: {} } } }]
  statements = []
  order = []
  mocks.getPool.mockReturnValue(pool)
  mocks.getDrizzle.mockReturnValue({ transaction: mocks.transaction })
  mocks.transaction.mockImplementation(async (callback: (client: unknown) => Promise<unknown>) => {
    order.push('begin')
    const result = await callback(tx)
    order.push('commit')
    return result
  })
  mocks.execute.mockImplementation(async (statement) => {
    const query = dialect.sqlToQuery(statement)
    statements.push(query)
    if (query.sql.includes('FOR UPDATE'))
      order.push('lock')
    if (query.sql.includes('UPDATE public.apps')) {
      order.push('write')
      return { rows: [] }
    }
    if (query.sql.includes('FROM public.apps'))
      return { rows: query.sql.includes('WHERE app_id =') ? rows.filter(row => row.app_id === query.params[0]) : rows }
    return { rows: [] }
  })
  mocks.permission.mockImplementation(async () => {
    expect(order).toContain('lock')
    return true
  })
  mocks.track.mockImplementation(async () => {
    expect(order.at(-1)).toBe('commit')
  })
})

describe('authorized onboarding mutation', () => {
  it.each(['app.update_settings', 'org.create_app'])('allows all fully qualified steps after one normal %s check', async (permission) => {
    mocks.permission.mockImplementation(async (_c, requested) => requested === permission)
    const build = vi.fn(({ current, allowedSteps, at }) => {
      expect(order.at(-1)).toBe('lock')
      expect(current).toMatchObject({ todo_list_version: 3, steps: {} })
      expect(allowedSteps).toEqual(new Set(['ota.add_channel', 'builder.some_step']))
      return { steps: { add_channel: { status: 'done' as const, at } } }
    })
    const afterPersist = vi.fn(async (client, result) => {
      expect(client).toBe(tx)
      expect(order.at(-1)).toBe('write')
      expect(result.onboarding.setup.steps.add_channel.update_history).toHaveLength(1)
    })
    const result = await persistAuthorizedOnboardingMutation(context(), appId, { requestedSteps: ['ota.add_channel', 'builder.some_step'], buildPatch: build, afterPersist })
    expect(build).toHaveBeenCalledOnce()
    expect(afterPersist).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ appId, orgId: 'fixture-org', historyChanges: [{ stepId: 'add_channel', status: 'done', historyLength: 1, historyFull: false }] })
    const setup = result!.onboarding.setup as any
    expect(setup.updated_at).toBe(setup.steps.add_channel.at)
    expect(result!.historyChanges[0].at).toBe(setup.updated_at)
    expect(mocks.permission.mock.calls.map(call => call[1])).toEqual(permission === 'app.update_settings' ? ['app.update_settings'] : ['app.update_settings', 'org.create_app'])
    expect(mocks.permission.mock.calls.at(-1)?.[2]).toEqual(permission === 'org.create_app' ? { orgId: 'fixture-org' } : { appId })
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith(expect.anything(), pool)
  })

  it.each(['apikey', 'jwt'] as const)('uses an explicit app.read override only for its matching API-key step with %s auth', async (authType) => {
    mocks.permission.mockImplementation(async (_c, permission) => permission === 'app.read')
    const build = vi.fn(({ allowedSteps }) => {
      expect(allowedSteps).toEqual(new Set(['ota.login_cli_mcp']))
      return { steps: { login_cli_mcp: { status: 'done' as const } } }
    })
    const result = await persistAuthorizedOnboardingMutation(context({ ...auth, authType }), appId, {
      requestedSteps: ['ota.login_cli_mcp', 'ota.add_channel', 'ota.run_device', 'ota.upload_bundle', 'ota.test_update'],
      stepOverrides: overrides,
      buildPatch: build,
    })
    expect(build).toHaveBeenCalledTimes(authType === 'apikey' ? 1 : 0)
    expect(result?.historyChanges.map(change => change.stepId) ?? []).toEqual(authType === 'apikey' ? ['login_cli_mcp'] : [])
    expect(mocks.permission.mock.calls.filter(call => call[1] === 'app.read')).toHaveLength(authType === 'apikey' ? 1 : 0)
  })

  it('does not call the builder when the API key lacks app.read and normal write access', async () => {
    mocks.permission.mockResolvedValue(false)
    const build = vi.fn(buildPatch)
    expect(await persistAuthorizedOnboardingMutation(context(), appId, { requestedSteps: ['ota.login_cli_mcp'], stepOverrides: overrides, buildPatch: build })).toBeNull()
    expect(build).not.toHaveBeenCalled()
    expect(order).toEqual(['begin', 'lock', 'commit'])
  })

  it('reuses a caller-owned database client and never closes it', async () => {
    const client = {} as Parameters<typeof persistAuthorizedOnboardingMutation>[3]
    await persistAuthorizedOnboardingMutation(context(), appId, { requestedSteps: ['ota.add_channel'], buildPatch }, client)
    expect(mocks.getPool).not.toHaveBeenCalled()
    expect(mocks.getDrizzle).toHaveBeenCalledWith(client, { logger: false })
    expect(mocks.close).not.toHaveBeenCalled()
    expect(statements.some(query => query.sql.includes('try_complete'))).toBe(false)
  })

  it('reuses an already locked transaction without opening or closing resources', async () => {
    order.push('lock')
    await persistLockedAuthorizedOnboardingMutation(context(), tx as any, appId, rows[0], { requestedSteps: ['ota.add_channel'], buildPatch })
    expect(mocks.getPool).not.toHaveBeenCalled()
    expect(mocks.getDrizzle).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.close).not.toHaveBeenCalled()
    expect(order).toEqual(['lock', 'write'])
  })

  it.each(['permission', 'write', 'afterPersist', 'commit'])('propagates %s errors and closes owned resources', async (failure) => {
    const error = new Error(failure)
    const afterPersist = vi.fn(async () => {
      if (failure === 'afterPersist')
        throw error
    })
    if (failure === 'permission')
      mocks.permission.mockRejectedValue(error)
    if (failure === 'write') {
      const original = mocks.execute.getMockImplementation()!
      mocks.execute.mockImplementation(async statement => dialect.sqlToQuery(statement).sql.includes('UPDATE public.apps') ? Promise.reject(error) : original(statement))
    }
    if (failure === 'commit') {
      mocks.transaction.mockImplementation(async (callback) => {
        await callback(tx)
        throw error
      })
    }
    await expect(persistAuthorizedOnboardingMutation(context(), appId, { requestedSteps: ['ota.add_channel'], buildPatch, afterPersist })).rejects.toBe(error)
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(mocks.track).not.toHaveBeenCalled()
  })

  it('does not write or complete a missing app or a null patch', async () => {
    const afterPersist = vi.fn()
    expect(await persistAuthorizedOnboardingMutation(context(), 'com.test.missing', { requestedSteps: ['ota.add_channel'], buildPatch, afterPersist })).toBeNull()
    expect(await persistAuthorizedOnboardingMutation(context(), appId, { requestedSteps: ['ota.add_channel'], buildPatch: () => null, afterPersist })).toBeNull()
    expect(afterPersist).not.toHaveBeenCalled()
    expect(order).not.toContain('write')
  })

  it('bounds repeated scope transfers to three rolled-back attempts before returning a conflict', async () => {
    mocks.execute.mockReset()
    for (let attempt = 0; attempt < 3; attempt++) {
      mocks.execute.mockResolvedValueOnce({ rows: [{ owner_org: `org-${attempt}` }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ onboarding: rows[0].onboarding, owner_org: `org-${attempt + 1}` }] })
    }
    await expect(persistAuthorizedOnboardingMutation(context(), appId, { requestedSteps: ['ota.add_channel'], buildPatch })).rejects.toMatchObject({ status: 409 })
    expect(mocks.transaction).toHaveBeenCalledTimes(3)
    expect(mocks.execute).toHaveBeenCalledTimes(9)
    expect(mocks.permission).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledOnce()
  })
})

describe('tracking CLI and MCP onboarding', () => {
  it.each([['user-login', 'User CLI login', 'cli'], ['cli-usage', 'CLI Command Invoked', 'cli'], ['mcp', 'MCP Tool Invoked', 'mcp']])('keeps %s multi-app changes in one transaction and emits only after commit', async (channel, event, source) => {
    rows.push({ app_id: 'com.test.second', owner_org: 'second-org', onboarding: { setup: { todo_list_version: 4, ota_todo_list_version: '1', steps: { ota: {} } } } })
    mocks.permission.mockImplementation(async (_c, permission) => permission === 'app.read')
    await markAppOnboardingLoginFromTracking(context(), channel, event)
    expect(mocks.transaction).toHaveBeenCalledOnce()
    expect(statements[0].sql).toContain('FOR UPDATE')
    expect(statements[0].sql).toContain('onboarding ->> \'created_by_user_id\'')
    expect(statements.filter(query => query.sql.includes('try_complete_pending_onboarding_if_setup_done'))).toHaveLength(2)
    expect(mocks.track).toHaveBeenCalledTimes(2)
    for (const [index, row] of rows.entries()) {
      const tracked = mocks.track.mock.calls[index][1]
      expect(tracked).toMatchObject({ event: 'App Onboarding Step Changed', user_id: auth.userId, groups: { organization: row.owner_org }, nonPersonTags: { app_id: row.app_id, onboarding_source: source, step_id: 'login_cli_mcp', history_length: 1, auth_type: 'apikey' } })
      const write = statements.filter(query => query.sql.includes('UPDATE public.apps'))[index]
      const saved = JSON.parse(write.params[0] as string)
      const step = index === 0 ? saved.setup.steps.login_cli_mcp : saved.setup.steps.ota.login_cli_mcp
      expect(step).toEqual({ status: 'done', at: tracked.timestamp, update_history: [{ status: 'done', at: tracked.timestamp }] })
    }
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('does not emit any derived history if the outer multi-app commit fails', async () => {
    mocks.transaction.mockImplementation(async (callback) => {
      await callback(tx)
      throw new Error('commit failed')
    })
    await markAppOnboardingLoginFromTracking(context(), 'mcp', 'MCP Tool Invoked')
    expect(order).toContain('write')
    expect(mocks.track).not.toHaveBeenCalled()
    expect(mocks.log).toHaveBeenCalledOnce()
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('ignores unrelated events, JWT events, Builder-only apps, and unchanged login state', async () => {
    await markAppOnboardingLoginFromTracking(context(), 'other', 'MCP Tool Invoked')
    await markAppOnboardingLoginFromTracking(context({ ...auth, authType: 'jwt' }), 'mcp', 'MCP Tool Invoked')
    expect(mocks.getPool).not.toHaveBeenCalled()
    rows[0].onboarding = { setup: { todo_list_version: 4, builder_todo_list_version: '1', steps: { builder: {} } } }
    rows.push({ app_id: 'com.test.done', owner_org: 'fixture-org', onboarding: { setup: { todo_list_version: 3, source: 'mcp', steps: { login_cli_mcp: { status: 'done' } } } } })
    await markAppOnboardingLoginFromTracking(context(), 'mcp', 'MCP Tool Invoked')
    expect(order).not.toContain('write')
    expect(mocks.track).not.toHaveBeenCalled()
  })

  it('promotes CLI to MCP with the existing timestamp and history behavior', async () => {
    rows[0].onboarding.setup = { todo_list_version: 3, source: 'cli', steps: { login_cli_mcp: { status: 'done', at: 'old', update_history: [{ status: 'done', at: 'old' }] } } }
    await markAppOnboardingLoginFromTracking(context(), 'mcp', 'MCP Tool Invoked')
    const saved = JSON.parse(statements.find(query => query.sql.includes('UPDATE public.apps'))!.params[0] as string)
    expect(saved.setup.source).toBe('mcp')
    expect(saved.setup.steps.login_cli_mcp.at).not.toBe('old')
    expect(saved.setup.steps.login_cli_mcp.update_history).toEqual([{ status: 'done', at: 'old' }, { status: 'done', at: saved.setup.updated_at }])
    expect(mocks.track.mock.calls[0][1].nonPersonTags.history_length).toBe(2)
  })

  it('authorizes each candidate separately and retains legacy v2 tracking', async () => {
    rows[0].onboarding.setup.todo_list_version = 2
    rows.push({ app_id: 'com.test.denied', owner_org: 'other-org', onboarding: rows[0].onboarding })
    mocks.permission.mockImplementation(async (_c, permission, scope) => permission === 'app.read' && scope.appId === appId)
    await markAppOnboardingLoginFromTracking(context({ ...auth, apikey: { ...auth.apikey!, key: null } }), 'cli-usage', 'CLI Command Invoked')
    expect(statements.filter(query => query.sql.includes('UPDATE public.apps'))).toHaveLength(1)
    expect(mocks.track).toHaveBeenCalledOnce()
    expect(mocks.track.mock.calls[0][1].nonPersonTags.todo_list_version).toBe(2)
    expect(mocks.permission.mock.calls.every(call => call[5] === 'fallback-key')).toBe(true)
  })
})
