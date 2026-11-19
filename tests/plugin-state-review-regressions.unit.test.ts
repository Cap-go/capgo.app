import type { SQL } from 'drizzle-orm'
import type { Context } from 'hono'
import type { PluginStateChannelRow } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'
import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { PgDialect } from 'drizzle-orm/pg-core'
import { Hono } from 'hono/tiny'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pluginStateAppKey, pluginStateDeviceKey, pluginStateManifestKey, pluginStateVersionKey } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'
import { createPluginStateSourceReader, createPluginStateSyncStore, drainPluginStateSync, drainServingPolicies, syncPluginStateManifestPage } from '../supabase/functions/_backend/triggers/plugin_state_sync.ts'
import { getPgClient } from '../supabase/functions/_backend/utils/pg.ts'
import { publicationProviders } from './plugin-state-publication-fixture.ts'

interface Connection { route: 'primary' | 'eu' }
interface Statement { sql: string, params: unknown[] }
type Job = { kind: 'app' | 'full' | 'device' | 'version' | 'manifest', ref: string }

const provider = vi.hoisted(() => ({
  connect: vi.fn(), execute: vi.fn(), marker: vi.fn(), inventory: vi.fn(),
  owner: vi.fn(), channels: vi.fn(), channelListIds: vi.fn(), log: vi.fn(),
}))
const dialect = new PgDialect()
const barrier = '2026-11-18 12:00:00.123456+00'
const fixtureOrg = '00000000-0000-4000-8000-000000000001'

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: provider.connect,
  getDrizzleClient: (client: Connection) => ({ execute: async (query: SQL) => {
    const statement = dialect.sqlToQuery(query)
    if (statement.sql.includes('FROM public.read_replica_commit_marker'))
      return provider.marker(client, statement)
    if (statement.sql.includes('prepare_plugin_state_inventory'))
      return provider.inventory(client, statement)
    return provider.execute(client, statement)
  } }),
  withPgTransaction: async <T>(client: Connection, run: (client: Connection) => Promise<T>) => run(client),
  closeClient: vi.fn(),
}))
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: provider.log, cloudlogErr: provider.log, serializeError: (error: unknown) => error,
}))
vi.mock('../supabase/functions/_backend/plugin_runtime/utils/pluginStateSelects.ts', () => ({
  selectPluginStateOwner: provider.owner,
  selectPluginStateChannels: provider.channels,
  selectPluginStateChannelListIds: provider.channelListIds,
}))

beforeEach(() => {
  vi.resetAllMocks()
  provider.connect.mockImplementation(async (_context: unknown, route?: boolean | 'eu-replica') => ({ route: route === 'eu-replica' ? 'eu' : 'primary' }))
  provider.marker.mockResolvedValue({ rows: [{ ready: true }] })
  provider.inventory.mockResolvedValue({ rows: [{ page: null }] })
  provider.owner.mockResolvedValue(null)
  provider.channels.mockResolvedValue([])
  provider.channelListIds.mockResolvedValue([])
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function argument(statement: Statement, name: string) {
  const match = new RegExp(`${name}\\s*=>\\s*\\$(\\d+)`).exec(statement.sql)
  if (!match)
    throw new Error(`Missing SQL argument ${name}`)
  return statement.params[Number(match[1]) - 1]
}

function claimed(appId: string, jobs: Job[], attempts = 1) {
  return { rows: [{ result: { status: 'ok', lease_token: 'fixture-lease', generation: '2', has_more: false,
    apps: [{ app_id: appId, jobs, attempts, required_commit_at: barrier }],
  } }] }
}

function controlDefault(statement: Statement) {
  if (statement.sql.includes('claim_serving_policy_sync_source'))
    return { rows: [] }
  if (statement.sql.includes('plugin_state_sync_enabled'))
    return { rows: [{ enabled: true }] }
  if (statement.sql.includes('claim_plugin_state_sync('))
    return { rows: [{ result: { status: 'empty' } }] }
  if (statement.sql.includes('claim_plugin_state_gc'))
    return { rows: [{ result: null }] }
  if (statement.sql.includes('ack_plugin_state_sync_progress'))
    return { rows: [] }
  throw new Error(`Unexpected statement: ${statement.sql}`)
}

async function drain(storage: ReturnType<typeof publicationProviders>) {
  const app = new Hono<MiddlewareKeyVariables>()
  app.post('/', async c => c.json(await drainPluginStateSync(c)))
  const response = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
  expect(response.status).toBe(200)
  return response.json<{ claims: number, apps: number, failed: number }>()
}

async function inContext(run: (c: Context<MiddlewareKeyVariables>) => Promise<void>) {
  const app = new Hono<MiddlewareKeyVariables>()
  app.get('/', async (c) => {
    await run(c)
    return c.json({ status: 'ok' })
  })
  expect((await app.request('/')).status).toBe(200)
}

function appChannels(versionIds: number[]): PluginStateChannelRow[] {
  return versionIds.map((id, index) => ({
    channels: { id: index + 1, name: `channel-${index}` }, version: { id }, rolloutVersion: { id: null },
    version_ref: id, owner_org: fixtureOrg,
  }))
}

describe('source loss and mixed publication settlement', () => {
  it('defers the original full cursor when readiness is lost after a published versions page', async () => {
    const storage = publicationProviders()
    const appId = 'com.example.full-source-loss'
    const cursor = JSON.stringify({ p: 'versions', after: 'old' })
    const acks: Statement[] = []
    let claims = 0
    provider.marker.mockResolvedValueOnce({ rows: [{ ready: true }] })
      .mockResolvedValueOnce({ rows: [{ ready: true }] }).mockResolvedValue({ rows: [{ ready: false }] })
    provider.execute.mockImplementation(async (client: Connection, statement: Statement) => {
      if (statement.sql.includes('claim_plugin_state_sync(') && ++claims === 1)
        return claimed(appId, [{ kind: 'full', ref: cursor }])
      if (statement.sql.includes('SELECT 1 AS found')) {
        expect(client.route).toBe('eu')
        return { rows: [{ found: 1 }] }
      }
      if (statement.sql.includes('ORDER BY av.name'))
        return { rows: Array.from({ length: 48 }, (_, index) => ({ id: index + 1, name: `version-${String(index).padStart(3, '0')}`, owner_org: fixtureOrg, deleted: false })) }
      if (statement.sql.includes('ack_plugin_state_sync_progress'))
        acks.push(statement)
      return controlDefault(statement)
    })
    expect(await drain(storage)).toEqual({ claims: 1, apps: 0, failed: 0 })
    expect(storage.publishedValue(await pluginStateVersionKey(appId, 'version-000'))).toMatchObject({ id: 1 })
    expect(acks).toHaveLength(1)
    expect(argument(acks[0], 'p_done')).toEqual([])
    expect(argument(acks[0], 'p_deferred')).toEqual([appId])
    expect(argument(acks[0], 'p_full_done')).toEqual([])
    expect(argument(acks[0], 'p_continuations')).toBe('{}')
  })

  it('propagates source deferral through the manifest page helper instead of advancing its cursor', async () => {
    provider.marker.mockResolvedValue({ rows: [{ ready: false }] })
    await inContext(async (c) => {
      const source = createPluginStateSourceReader(c, Date.now() + 1000, barrier)
      await expect(syncPluginStateManifestPage({
        versionIds: [10, 11], after: null, deadline: Date.now() + 1000, available: () => 100,
        write: async () => source.read(async () => undefined),
      })).rejects.toThrow('EU plugin state source unavailable')
    })
  })

  it.each(['source-first', 'provider-first'] as const)('charges mixed manifest failures in %s order while settling an independently completed version', async (order) => {
    const storage = publicationProviders()
    const appId = `com.example.mixed-${order}`
    const acks: Statement[] = []
    let claims = 0
    provider.marker.mockResolvedValueOnce({ rows: [{ ready: true }] })
      .mockResolvedValueOnce({ rows: [{ ready: order === 'provider-first' }] })
      .mockResolvedValueOnce({ rows: [{ ready: order === 'source-first' }] })
    const write = storage.namespace.put.getMockImplementation()!
    storage.namespace.put.mockImplementation(async (...args) => {
      const doc = JSON.parse(args[1])
      if (doc.version_id !== undefined)
        throw new Error('Synthetic manifest KV write failure')
      return write(...args)
    })
    provider.execute.mockImplementation(async (_client: Connection, statement: Statement) => {
      if (statement.sql.includes('claim_plugin_state_sync(') && ++claims === 1)
        return claimed(appId, [{ kind: 'version', ref: '1.0.0' }, { kind: 'manifest', ref: '10' }, { kind: 'manifest', ref: '11' }], 5)
      if (statement.sql.includes('av.name = ANY'))
        return { rows: [{ id: 100, name: '1.0.0', owner_org: fixtureOrg, deleted: false }] }
      if (statement.sql.includes('WHERE av.id ='))
        return { rows: [{ id: statement.params[0], app_id: appId, deleted: false }] }
      if (statement.sql.includes('AS estimated_bytes'))
        return { rows: [{ estimated_bytes: 4096 }] }
      if (statement.sql.includes('FROM public.version_files') || statement.sql.includes('FROM public.delta_files'))
        return { rows: [] }
      if (statement.sql.includes('ack_plugin_state_sync_progress'))
        acks.push(statement)
      return controlDefault(statement)
    })
    const result = await drain(storage)
    expect(storage.namespace.put.mock.calls.some(([, body]) => JSON.parse(body).version_id !== undefined)).toBe(true)
    expect(result).toEqual({ claims: 1, apps: 0, failed: 1 })
    expect(storage.publishedValue(await pluginStateVersionKey(appId, '1.0.0'))).toMatchObject({ id: 100 })
    expect(acks).toHaveLength(1)
    expect(argument(acks[0], 'p_failed')).toEqual([appId])
    expect(argument(acks[0], 'p_deferred')).toEqual([])
    expect(argument(acks[0], 'p_completed')).toBe(JSON.stringify({ [appId]: [{ kind: 'version', ref: '1.0.0' }] }))
  })

  it('still defers a pure group of manifest source failures without a retry purge', async () => {
    const storage = publicationProviders()
    const appId = 'com.example.pure-source-group'
    const acks: Statement[] = []
    let claims = 0
    provider.marker.mockResolvedValue({ rows: [{ ready: false }] })
    provider.execute.mockImplementation(async (_client: Connection, statement: Statement) => {
      if (statement.sql.includes('claim_plugin_state_sync(') && ++claims === 1)
        return claimed(appId, [{ kind: 'manifest', ref: '10' }, { kind: 'manifest', ref: '11' }], 5)
      if (statement.sql.includes('ack_plugin_state_sync_progress'))
        acks.push(statement)
      return controlDefault(statement)
    })
    expect(await drain(storage)).toEqual({ claims: 1, apps: 0, failed: 0 })
    expect(argument(acks[0], 'p_deferred')).toEqual([appId])
    expect(argument(acks[0], 'p_failed')).toEqual([])
    expect(argument(acks[0], 'p_changed_apps')).toEqual([])
    expect(storage.namespace.put).not.toHaveBeenCalled()
    expect(storage.pointers.put).not.toHaveBeenCalled()
    expect(provider.marker).toHaveBeenCalledTimes(2)
  })
})

describe('current app freshness during full history work', () => {
  it('protects app publication capacity from competing history work without exceeding the shared cap', async () => {
    const storage = publicationProviders()
    const budget = { remaining: 20 }
    const appStore = createPluginStateSyncStore(storage.namespace, storage.pointers, '2', budget)
    const historyStore = createPluginStateSyncStore(storage.namespace, storage.pointers, '2', budget)
    const appId = 'com.example.reserved-app-publication'
    const appKey = await pluginStateAppKey(appId)
    const release = appStore.reserveAppPublication(appKey)
    for (const name of ['v0', 'v1'])
      await historyStore.putJson(await pluginStateVersionKey(appId, name), { id: 1 })
    await expect(historyStore.putJson(await pluginStateVersionKey(appId, 'v2'), { id: 2 })).rejects.toThrow('provider operation budget exhausted')
    expect(budget.remaining).toBe(0)
    await appStore.putJson(appKey, { f: 1, app_id: appId, exists: false })
    expect(appStore.hasPublished(appKey)).toBe(true)
    release()
    const remaining = budget.remaining
    release()
    expect(budget.remaining).toBe(remaining)
    const operations = storage.namespace.put.mock.calls.length + storage.namespace.get.mock.calls.length
      + storage.pointers.put.mock.calls.length + storage.pointers.get.mock.calls.length
    expect(operations).toBe(20 - budget.remaining)
    expect(operations).toBeLessThanOrEqual(20)
  })

  it.each(['app', 'device'] as const)('publishes current state before acknowledging a yielded full scan plus %s change', async (kind) => {
    const storage = publicationProviders()
    const appId = `com.example.full-current-${kind}`
    const acks: Statement[] = []
    let claims = 0
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    provider.owner.mockResolvedValue({ owner_org: fixtureOrg })
    provider.channels.mockResolvedValue(appChannels([100]))
    provider.channelListIds.mockResolvedValue([1])
    const put = storage.namespace.put.getMockImplementation()!
    storage.namespace.put.mockImplementation(async (...args) => {
      const doc = JSON.parse(args[1])
      if (doc.id === 101)
        now += 8001
      return put(...args)
    })
    provider.execute.mockImplementation(async (_client: Connection, statement: Statement) => {
      if (statement.sql.includes('claim_plugin_state_sync(') && ++claims === 1)
        return claimed(appId, [{ kind: 'full', ref: JSON.stringify({ p: 'versions', after: null }) }, { kind, ref: kind === 'device' ? 'fixture-device' : '' }])
      if (statement.sql.includes('SELECT 1 AS found'))
        return { rows: [{ found: 1 }] }
      if (statement.sql.includes('ORDER BY av.name'))
        return { rows: [{ id: 101, name: 'old-history', owner_org: fixtureOrg, deleted: false }] }
      if (statement.sql.includes('FROM public.channel_devices'))
        return { rows: [{ device_id: 'fixture-device', channel_id: 9 }] }
      if (statement.sql.includes('FROM public.orgs'))
        return { rows: [{ customer_id: null, has_credits: true }] }
      if (statement.sql.includes('ack_plugin_state_sync_progress'))
        acks.push(statement)
      return controlDefault(statement)
    })
    expect(await drain(storage)).toEqual({ claims: 1, apps: 1, failed: 0 })
    expect(storage.publishedValue(await pluginStateAppKey(appId))).toMatchObject({
      exists: true, plan: { has_credits: true }, channels: appChannels([100]),
      overrides: { 'fixture-device': 9 }, manifest_ids: [],
    })
    if (kind === 'device')
      expect(storage.publishedValue(await pluginStateDeviceKey(appId, 'fixture-device'))).toEqual({ channel_id: 9 })
    expect(argument(acks[0], 'p_done')).toEqual([appId])
    expect(argument(acks[0], 'p_app_published')).toEqual([appId])
    expect(argument(acks[0], 'p_continuations')).not.toBe('{}')
  })

  it('retains app and full work when the bounded refresh itself loses source readiness', async () => {
    const storage = publicationProviders()
    const appId = 'com.example.refresh-source-loss'
    const acks: Statement[] = []
    let claims = 0
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const put = storage.namespace.put.getMockImplementation()!
    storage.namespace.put.mockImplementation(async (...args) => { now += 8001; return put(...args) })
    provider.marker.mockResolvedValueOnce({ rows: [{ ready: true }] })
      .mockResolvedValueOnce({ rows: [{ ready: true }] }).mockResolvedValue({ rows: [{ ready: false }] })
    provider.execute.mockImplementation(async (_client: Connection, statement: Statement) => {
      if (statement.sql.includes('claim_plugin_state_sync(') && ++claims === 1)
        return claimed(appId, [{ kind: 'full', ref: JSON.stringify({ p: 'versions', after: null }) }, { kind: 'app', ref: '' }])
      if (statement.sql.includes('SELECT 1 AS found'))
        return { rows: [{ found: 1 }] }
      if (statement.sql.includes('ORDER BY av.name'))
        return { rows: [{ id: 101, name: 'old-history', owner_org: fixtureOrg, deleted: false }] }
      if (statement.sql.includes('ack_plugin_state_sync_progress'))
        acks.push(statement)
      return controlDefault(statement)
    })
    expect(await drain(storage)).toEqual({ claims: 1, apps: 0, failed: 0 })
    expect(argument(acks[0], 'p_done')).toEqual([])
    expect(argument(acks[0], 'p_deferred')).toEqual([appId])
    expect(argument(acks[0], 'p_continuations')).toBe('{}')
    expect(storage.publishedValue(await pluginStateAppKey(appId))).toBeNull()
  })

  it('keeps the complete terminal app snapshot as the sole app publication for its generation', async () => {
    const storage = publicationProviders()
    const appId = 'com.example.terminal-full-current'
    const acks: Statement[] = []
    let claims = 0
    provider.owner.mockResolvedValue({ owner_org: fixtureOrg })
    provider.channels.mockResolvedValue(appChannels([100]))
    provider.channelListIds.mockResolvedValue([1])
    provider.execute.mockImplementation(async (_client: Connection, statement: Statement) => {
      if (statement.sql.includes('claim_plugin_state_sync(') && ++claims === 1)
        return claimed(appId, [{ kind: 'full', ref: JSON.stringify({ p: 'manifests', after: null, revision: null }) }, { kind: 'app', ref: '' }])
      if (statement.sql.includes('SELECT 1 AS found'))
        return { rows: [{ found: 1 }] }
      if (statement.sql.includes('FROM public.orgs'))
        return { rows: [{ customer_id: null, has_credits: true }] }
      if (statement.sql.includes('FROM public.channel_devices'))
        return { rows: [] }
      if (statement.sql.includes('WHERE av.id ='))
        return { rows: [{ id: 100, app_id: appId, deleted: false }] }
      if (statement.sql.includes('AS estimated_bytes'))
        return { rows: [{ estimated_bytes: 4096 }] }
      if (statement.sql.includes('FROM public.version_files') || statement.sql.includes('FROM public.delta_files'))
        return { rows: [] }
      if (statement.sql.includes('ack_plugin_state_sync_progress'))
        acks.push(statement)
      return controlDefault(statement)
    })
    expect(await drain(storage)).toEqual({ claims: 1, apps: 1, failed: 0 })
    expect(storage.publishedValue(await pluginStateAppKey(appId))).toMatchObject({ exists: true, manifest_ids: [100] })
    expect(storage.publishedValue(pluginStateManifestKey(100))).toMatchObject({ version_id: 100 })
    const appWrites = storage.namespace.put.mock.calls.filter(([, body]) => JSON.parse(body).exists !== undefined)
    expect(appWrites).toHaveLength(1)
    expect(argument(acks[0], 'p_full_done')).toEqual([appId])
  })
})

describe('queued policy work and inventory isolation', () => {
  it('serves an already queued policy before a slow inventory page consumes its policy window', async () => {
    const storage = publicationProviders()
    const events: string[] = []
    let now = 1_000_000
    let policyClaims = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    provider.inventory.mockImplementation(async (_client: Connection, statement: Statement) => {
      if (statement.params[0] === 'policy') {
        events.push('inventory')
        now += 10_001
      }
      return { rows: [{ page: null }] }
    })
    provider.execute.mockImplementation(async (_client: Connection, statement: Statement) => {
      if (statement.sql.includes('claim_serving_policy_sync_source')) {
        events.push('policy-claim')
        return { rows: ++policyClaims === 1 ? [{ token: 'policy-lease', generation: '1', app_id: 'com.example.queued-policy', active_epoch: null, required_commit_at: barrier }] : [] }
      }
      if (statement.sql.includes('SELECT serving_regions'))
        return { rows: [{ serving_regions: null, serving_region_mode: null }] }
      if (statement.sql.includes('ack_serving_policy_sync'))
        return { rows: [] }
      return controlDefault(statement)
    })
    expect(await drain(storage)).toEqual({ claims: 1, apps: 1, failed: 0 })
    expect(events.indexOf('policy-claim')).toBeLessThan(events.indexOf('inventory'))
    expect(storage.pointers.put).toHaveBeenCalled()
  })

  it('continues queued policy and payload work after a policy inventory commit fails', async () => {
    const storage = publicationProviders()
    let policyClaims = 0
    let payloadClaims = 0
    provider.inventory.mockImplementation(async (_client: Connection, statement: Statement) => ({ rows: [{ page: statement.params[0] === 'policy'
      ? { after: null, required_commit_at: barrier, epoch: '', known_ids: [] } : null }] }))
    provider.execute.mockImplementation(async (_client: Connection, statement: Statement) => {
      if (statement.sql.includes('claim_serving_policy_sync_source'))
        return { rows: ++policyClaims === 1 ? [{ token: 'policy-lease', generation: '1', app_id: 'com.example.inventory-error', active_epoch: null, required_commit_at: barrier }] : [] }
      if (statement.sql.includes('SELECT serving_regions'))
        return { rows: [{ serving_regions: null, serving_region_mode: null }] }
      if (statement.sql.includes('ack_serving_policy_sync'))
        return { rows: [] }
      if (statement.sql.includes('SELECT inventory.app_id'))
        return { rows: [{ app_id: 'com.example.inventory-error' }] }
      if (statement.sql.includes('commit_plugin_state_inventory'))
        throw new Error('Synthetic inventory cursor commit failure')
      if (statement.sql.includes('claim_plugin_state_sync(') && ++payloadClaims === 1)
        return claimed('com.example.inventory-error', [{ kind: 'version', ref: '1.0.0' }])
      if (statement.sql.includes('av.name = ANY'))
        return { rows: [{ id: 100, name: '1.0.0', owner_org: fixtureOrg, deleted: false }] }
      return controlDefault(statement)
    })
    const result = await drain(storage)
    expect(result.apps).toBe(2)
    expect(result.failed).toBe(1)
    expect(storage.publishedValue(await pluginStateVersionKey('com.example.inventory-error', '1.0.0'))).toMatchObject({ id: 100 })
    expect(storage.pointers.put).toHaveBeenCalledWith(expect.stringMatching(/^sr1:/), expect.any(String), expect.anything())
  })

  it('defers a policy claim whose deadline expires before source I/O', async () => {
    const storage = publicationProviders()
    const statements: string[] = []
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    provider.execute.mockImplementation(async (_client: Connection, statement: Statement) => {
      statements.push(statement.sql)
      if (statement.sql.includes('claim_serving_policy_sync_source')) {
        now += 1001
        return { rows: [{ token: 'deadline-policy', generation: '1', app_id: 'com.example.deadline-policy', active_epoch: null, required_commit_at: barrier }] }
      }
      if (statement.sql.includes('defer_serving_policy_sync') || statement.sql.includes('ack_serving_policy_sync'))
        return { rows: [] }
      throw new Error(`Unexpected statement: ${statement.sql}`)
    })
    const result = { claims: 0, apps: 0, failed: 0 }
    await inContext(async c => drainServingPolicies(c, await getPgClient(c), storage.pointers, { remaining: 11 }, now + 1000, result))
    expect(result).toEqual({ claims: 1, apps: 0, failed: 0 })
    expect(statements.some(sql => sql.includes('defer_serving_policy_sync'))).toBe(true)
    expect(statements.some(sql => sql.includes('ack_serving_policy_sync'))).toBe(false)
    expect(provider.connect.mock.calls.every(call => call[1] !== 'eu-replica')).toBe(true)
    expect(storage.pointers.put).not.toHaveBeenCalled()
  })

  it('does not refund policy capacity exhaustion after a provider operation has started', async () => {
    const storage = publicationProviders()
    const budget = { remaining: 11 }
    const statements: Statement[] = []
    const get = storage.pointers.get.getMockImplementation()!
    storage.pointers.get.mockImplementation(async (...args) => {
      const response = await get(...args)
      budget.remaining = 0
      return response
    })
    provider.execute.mockImplementation(async (_client: Connection, statement: Statement) => {
      statements.push(statement)
      if (statement.sql.includes('claim_serving_policy_sync_source'))
        return { rows: [{ token: 'provider-policy', generation: '1', app_id: 'com.example.provider-policy', active_epoch: null, required_commit_at: barrier }] }
      if (statement.sql.includes('SELECT serving_regions'))
        return { rows: [{ serving_regions: null, serving_region_mode: null }] }
      if (statement.sql.includes('ack_serving_policy_sync'))
        return { rows: [] }
      throw new Error(`Unexpected statement: ${statement.sql}`)
    })
    const result = { claims: 0, apps: 0, failed: 0 }
    await inContext(async c => drainServingPolicies(c, await getPgClient(c), storage.pointers, budget, Date.now() + 1000, result))
    expect(result).toEqual({ claims: 1, apps: 0, failed: 1 })
    expect(storage.pointers.get).toHaveBeenCalledTimes(1)
    expect(statements.some(statement => statement.sql.includes('defer_serving_policy_sync'))).toBe(false)
    expect(statements.find(statement => statement.sql.includes('ack_serving_policy_sync'))?.params).toEqual(['provider-policy', false])
  })
})
