import type { SQL } from 'drizzle-orm'
import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { PgDialect } from 'drizzle-orm/pg-core'
import { Hono } from 'hono/tiny'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pluginStateVersionKey } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'
import { servingRegionReaderEpoch } from '../supabase/functions/_backend/plugin_runtime/utils/servingRegionRollout.js'
import { app as syncApp, buildManifestDoc, createPluginStateSourceReader, createPluginStateSourceWork, drainPluginStateSync, drainServingPolicies, inventoryPluginState } from '../supabase/functions/_backend/triggers/plugin_state_sync.ts'
import { getPgClient } from '../supabase/functions/_backend/utils/pg.ts'
import { publicationProviders } from './plugin-state-publication-fixture.ts'

interface Connection { id: number, inTransaction: boolean }

const provider = vi.hoisted(() => ({
  connect: vi.fn<(context?: unknown, route?: boolean | 'eu-replica') => Promise<Connection>>(),
  select: vi.fn(),
  execute: vi.fn(),
  marker: vi.fn(),
  inventory: vi.fn(),
  transaction: vi.fn(),
  close: vi.fn(),
  log: vi.fn(),
}))

// Exercise the readiness GET with an explicitly prepared activation epoch.
vi.mock('../supabase/functions/_backend/plugin_runtime/utils/servingRegionRollout.js', () => ({
  servingRegionReaderEpoch: 'fixture-reader-epoch',
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: provider.connect,
  getDrizzleClient: (client: Connection) => ({ select: (...args: unknown[]) => provider.select(client, ...args), execute: async (query: SQL) => {
    const statement = dialect.sqlToQuery(query)
    if (statement.sql.includes('FROM public.read_replica_commit_marker'))
      return provider.marker(client, query)
    if (statement.sql.includes('public.prepare_plugin_state_inventory('))
      return provider.inventory(client, query)
    const result = await provider.execute(client, query)
    if (statement.sql.includes('public.claim_plugin_state_sync(')) {
      for (const row of result.rows)
        row.result.apps?.forEach((app: { required_commit_at: string }) => { app.required_commit_at = barrier })
    }
    if (statement.sql.includes('public.claim_serving_policy_sync_source('))
      result.rows.forEach((row: { required_commit_at: string }) => { row.required_commit_at = barrier })
    return result
  } }),
  withPgTransaction: provider.transaction,
  closeClient: provider.close,
}))
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: provider.log,
  cloudlogErr: provider.log,
  serializeError: (error: unknown) => error,
}))

const barrier = '2026-11-18 12:00:00.123456+00'
const dialect = new PgDialect()
let activeTransactions = 0
let peakTransactions = 0
let nextConnection = 0

beforeEach(() => {
  vi.clearAllMocks()
  provider.select.mockReset()
  activeTransactions = 0
  peakTransactions = 0
  nextConnection = 0
  provider.marker.mockResolvedValue({ rows: [{ ready: true }] })
  provider.inventory.mockResolvedValue({ rows: [{ page: null }] })
  provider.connect.mockImplementation(async () => ({ id: nextConnection++, inTransaction: false }))
  provider.transaction.mockImplementation(async <T>(client: Connection, run: (client: Connection) => Promise<T>, options?: { appendSql?: string }) => {
    expect(client.inTransaction).toBe(false)
    if (options)
      expect(options.appendSql).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    client.inTransaction = true
    activeTransactions++
    peakTransactions = Math.max(peakTransactions, activeTransactions)
    try {
      return await run(client)
    }
    finally {
      client.inTransaction = false
      activeTransactions--
    }
  })
  provider.close.mockImplementation((_context, client: Connection) => {
    expect(client.inTransaction).toBe(false)
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

async function inContext(run: (context: Context<MiddlewareKeyVariables>) => Promise<void>) {
  const app = new Hono<MiddlewareKeyVariables>()
  app.get('/', async (c) => {
    c.set('requestId', 'snapshot-source-test')
    await run(c)
    return c.json({ status: 'ok' })
  })
  const response = await app.request('/')
  expect(response.status).toBe(200)
}

describe('fresh plugin snapshot source transactions', () => {
  it('commits the source snapshot before provider I/O and acknowledges in its own transaction', async () => {
    const storage = publicationProviders()
    let claims = 0
    provider.execute.mockImplementation(async (client: Connection, query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('public.claim_serving_policy_sync_source('))
        return { rows: [] }
      if (statement.sql.includes('public.plugin_state_sync_enabled()'))
        return { rows: [{ enabled: true }] }
      if (statement.sql.includes('public.claim_plugin_state_sync(')) {
        expect(client.inTransaction).toBe(true)
        claims++
        return { rows: [{ result: { status: 'ok', lease_token: 'fixture-lease', generation: '1', has_more: false,
          apps: [{ app_id: 'com.test.freshsnapshot', jobs: [{ kind: 'version', ref: '1.0.0' }], attempts: 1 }],
        } }] }
      }
      if (statement.sql.includes('FROM public.app_versions av')) {
        // Plain queries emulate a previously warmed Hyperdrive result.
        return { rows: [{ id: client.inTransaction ? 202 : 101, owner_org: 'fixture-org', name: '1.0.0', deleted: false }] }
      }
      expect(client.inTransaction).toBe(true)
      expect(activeTransactions).toBe(1)
      return { rows: [] }
    })
    const originalPut = storage.namespace.put.getMockImplementation()!
    storage.namespace.put.mockImplementation(async (...args) => {
      expect(activeTransactions).toBe(0)
      await originalPut(...args)
    })
    const pointerPut = storage.pointers.put.getMockImplementation()!
    storage.pointers.put.mockImplementation(async (...args) => {
      expect(activeTransactions).toBe(0)
      return pointerPut(...args)
    })
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async c => c.json(await drainPluginStateSync(c)))
    const response = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
    expect(await response.json()).toEqual({ claims: 1, apps: 1, failed: 0 })
    expect(claims).toBe(1)
    expect(storage.publishedValue(await pluginStateVersionKey('com.test.freshsnapshot', '1.0.0'))).toMatchObject({ id: 202 })
    expect(provider.transaction).toHaveBeenCalledTimes(8)
    expect(provider.close).toHaveBeenCalledTimes(2)
  })

  it('routes source snapshots to EU even when the API worker is in another region', async () => {
    await inContext(async (c) => {
      const source = createPluginStateSourceReader(c, Date.now() + 10_000, barrier)
      await source.read(async () => undefined)
      expect(provider.connect).toHaveBeenCalledWith(c, 'eu-replica')
    })
  })

  it('does not expose source data while the replicated commit marker trails the claim', async () => {
    provider.marker.mockResolvedValue({ rows: [{ ready: false }] })
    const load = vi.fn(async () => 'stale-source')
    await inContext(async (c) => {
      const source = createPluginStateSourceReader(c, Date.now() + 10_000, barrier)
      await expect(source.read(load)).rejects.toThrow()
      expect(load).not.toHaveBeenCalled()
    })
  })

  it('uses separate handles and caps concurrent source snapshots at four', async () => {
    await inContext(async (c) => {
      const source = createPluginStateSourceReader(c, Date.now() + 10_000, barrier)
      const ready = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let started = 0
      const all = Promise.all(Array.from({ length: 8 }, () => source.read(async () => {
        started++
        if (started === 4)
          ready.resolve()
        await release.promise
      })))
      await ready.promise
      expect(started).toBe(4)
      expect(provider.connect).toHaveBeenCalledTimes(4)
      release.resolve()
      await all
      expect(peakTransactions).toBe(4)
      expect(provider.connect).toHaveBeenCalledTimes(8)
      expect(new Set(provider.transaction.mock.calls.map(([client]) => client.id)).size).toBe(8)
      expect(provider.close).toHaveBeenCalledTimes(8)
    })
  })

  it('holds the manifest gate across build and publication for all apps', async () => {
    await inContext(async (c) => {
      const ready = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let active = 0
      let peak = 0
      let started = 0
      const shared = createPluginStateSourceWork()
      const all = Promise.all(Array.from({ length: 8 }, () => createPluginStateSourceReader(c, Date.now() + 10_000, barrier, shared).manifest(async () => {
        active++
        started++
        peak = Math.max(peak, active)
        ready.resolve()
        await release.promise
        active--
      })))
      await ready.promise
      expect(started).toBe(1)
      release.resolve()
      await all
      expect(peak).toBe(1)
    })
  })

  it('returns an explicit memory fallback before loading a near-cap manifest', async () => {
    provider.execute.mockImplementation(async (client: Connection, query: SQL) => {
      expect(client.inTransaction).toBe(true)
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('public.claim_serving_policy_sync_source('))
        return { rows: [] }
      if (statement.sql.includes('public.plugin_state_sync_enabled()'))
        return { rows: [{ enabled: true }] }
      if (statement.sql.includes('AS estimated_bytes'))
        return { rows: [{ estimated_bytes: 5 * 1024 * 1024 }] }
      if (statement.sql.includes('FROM public.app_versions av'))
        return { rows: [{ id: 202, app_id: 'com.test.freshsnapshot', deleted: false }] }
      throw new Error('manifest rows should not be loaded after the memory preflight')
    })
    await inContext(async (c) => {
      const source = createPluginStateSourceReader(c, Date.now() + 10_000, barrier)
      expect(await buildManifestDoc(source, 202)).toMatchObject({
        f: 1, version_id: 202, app_id: 'com.test.freshsnapshot', fallback: 'replica', reason: 'worker_memory_limit',
      })
      expect(provider.execute).toHaveBeenCalledTimes(2)
      expect(activeTransactions).toBe(0)
    })
  })

  it('releases the checked-out handle when a source snapshot fails', async () => {
    await inContext(async (c) => {
      const source = createPluginStateSourceReader(c, Date.now() + 10_000, barrier)
      await expect(source.read(async () => { throw new Error('synthetic source failure') })).rejects.toThrow('EU plugin state source unavailable')
      expect(activeTransactions).toBe(0)
      expect(provider.close).toHaveBeenCalledTimes(1)
    })
  })
})

describe('plugin state queue mutation transactions', () => {
  it('acquires new leases and publishes the next work item when plain RPC results would be cached', async () => {
    const storage = publicationProviders()
    const appId = 'com.test.mutationqueue'
    const names = ['1.0.0', '2.0.0']
    const acknowledged: string[] = []
    let completed = 0
    let cachedClaims = 0
    const claimResult = (index: number) => ({
      status: 'ok',
      lease_token: `fixture-lease-${index + 1}`,
      generation: String(index + 1),
      has_more: true,
      apps: [{ app_id: appId, jobs: [{ kind: 'version', ref: names[index] }], attempts: 1 }],
    })
    const cachedFirstClaim = claimResult(0)
    provider.execute.mockImplementation(async (client: Connection, query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('public.claim_serving_policy_sync_source('))
        return { rows: [] }
      if (statement.sql.includes('public.plugin_state_sync_enabled()'))
        return { rows: [{ enabled: true }] }
      if (statement.sql.includes('public.claim_plugin_state_sync(')) {
        if (!client.inTransaction) {
          // Stop a broken drain quickly after demonstrating replay of an old lease.
          if (++cachedClaims > 2)
            throw new Error('cached mutation claim repeated after its ACK')
          return { rows: [{ result: cachedFirstClaim }] }
        }
        return { rows: [{ result: completed < names.length ? claimResult(completed) : { status: 'empty' } }] }
      }
      if (statement.sql.includes('public.ack_plugin_state_sync_progress(')) {
        const lease = statement.params[0]
        if (client.inTransaction && lease === `fixture-lease-${completed + 1}`) {
          acknowledged.push(lease)
          completed++
        }
        return { rows: [] }
      }
      if (statement.sql.includes('public.claim_plugin_state_gc(')) {
        expect(client.inTransaction).toBe(true)
        return { rows: [{ result: null }] }
      }
      if (statement.sql.includes('FROM public.app_versions av')) {
        expect(client.inTransaction).toBe(true)
        const name = names.find(value => statement.params.some(param => Array.isArray(param) && param.includes(value)))
        if (!name)
          throw new Error('expected a queued version name')
        return { rows: [{ id: name === names[0] ? 101 : 202, owner_org: 'fixture-org', name, deleted: false }] }
      }
      throw new Error(`unexpected queue query: ${statement.sql}`)
    })
    const originalGet = storage.pointers.get.getMockImplementation()!
    storage.pointers.get.mockImplementation(async (...args) => {
      expect(activeTransactions).toBe(0)
      return originalGet(...args)
    })
    const originalPut = storage.namespace.put.getMockImplementation()!
    storage.namespace.put.mockImplementation(async (...args) => {
      expect(activeTransactions).toBe(0)
      return originalPut(...args)
    })
    const originalPointerPut = storage.pointers.put.getMockImplementation()!
    storage.pointers.put.mockImplementation(async (...args) => {
      expect(activeTransactions).toBe(0)
      return originalPointerPut(...args)
    })
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async c => c.json(await drainPluginStateSync(c)))
    const response = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
    expect(await response.json()).toEqual({ claims: 2, apps: 2, failed: 0 })
    expect(acknowledged).toEqual(['fixture-lease-1', 'fixture-lease-2'])
    expect(cachedClaims).toBe(0)
    expect(storage.publishedValue(await pluginStateVersionKey(appId, names[0]))).toMatchObject({ id: 101 })
    expect(storage.publishedValue(await pluginStateVersionKey(appId, names[1]))).toMatchObject({ id: 202 })
    expect(activeTransactions).toBe(0)
  })

  it('commits each garbage-collection lease and cursor before resuming the next page', async () => {
    const storage = publicationProviders()
    let cursor: string | null = null
    let complete = false
    let lease = 0
    const acknowledgements: unknown[][] = []
    provider.execute.mockImplementation(async (client: Connection, query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('public.claim_serving_policy_sync_source('))
        return { rows: [] }
      if (statement.sql.includes('public.plugin_state_sync_enabled()'))
        return { rows: [{ enabled: true }] }
      expect(client.inTransaction).toBe(true)
      if (statement.sql.includes('public.claim_plugin_state_sync('))
        return { rows: [{ result: { status: 'empty' } }] }
      if (statement.sql.includes('public.claim_plugin_state_gc(')) {
        lease++
        return { rows: [{ result: complete ? null : { lease_token: `fixture-gc-${lease}`, cursor } }] }
      }
      if (statement.sql.includes('public.ack_plugin_state_gc(')) {
        expect(statement.params[0]).toBe(`fixture-gc-${lease}`)
        const nextCursor = statement.params[1]
        if (nextCursor !== null && typeof nextCursor !== 'string')
          throw new Error('invalid GC cursor')
        cursor = nextCursor
        complete = statement.params[2] === true
        acknowledgements.push(statement.params)
        return { rows: [] }
      }
      throw new Error(`unexpected garbage-collection query: ${statement.sql}`)
    })
    const listedCursors: (string | undefined)[] = []
    storage.namespace.list.mockImplementation(async (options) => {
      expect(activeTransactions).toBe(0)
      listedCursors.push(options.cursor)
      return options.cursor
        ? { keys: [], list_complete: true, cursor: undefined }
        : { keys: [], list_complete: false, cursor: 'fixture-gc-page-2' }
    })
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async c => c.json(await drainPluginStateSync(c)))
    for (let pass = 0; pass < 2; pass++) {
      const response = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
      expect(await response.json()).toEqual({ claims: 0, apps: 0, failed: 0 })
    }
    expect(listedCursors).toEqual([undefined, 'fixture-gc-page-2'])
    expect(acknowledgements).toEqual([
      ['fixture-gc-1', 'fixture-gc-page-2', false],
      ['fixture-gc-2', null, true],
    ])
    expect(complete).toBe(true)
    expect(activeTransactions).toBe(0)
  })

  it('commits an explicit repair enqueue before the request begins draining', async () => {
    vi.stubEnv('API_SECRET', 'fixture-api-secret')
    const storage = publicationProviders()
    const operations: string[] = []
    const appId = 'com.test.explicitmutationrepair'
    provider.execute.mockImplementation(async (client: Connection, query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('public.claim_serving_policy_sync_source('))
        return { rows: [] }
      if (statement.sql.includes('public.plugin_state_sync_enabled()'))
        return { rows: [{ enabled: true }] }
      expect(client.inTransaction).toBe(true)
      expect(activeTransactions).toBe(1)
      if (statement.sql.includes('public.enqueue_plugin_state_full_sync(')) {
        operations.push('enqueue')
        expect(statement.params).toEqual([[appId]])
        return { rows: [] }
      }
      if (statement.sql.includes('public.claim_plugin_state_sync(')) {
        operations.push('sync-claim')
        return { rows: [{ result: { status: 'empty' } }] }
      }
      if (statement.sql.includes('public.claim_plugin_state_gc(')) {
        operations.push('gc-claim')
        return { rows: [{ result: null }] }
      }
      throw new Error(`unexpected repair query: ${statement.sql}`)
    })
    const response = await syncApp.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apisecret': 'fixture-api-secret' },
      body: JSON.stringify({ apps: [appId], drain: true }),
    }, { API_SECRET: 'fixture-api-secret', PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', claims: 0, apps: 0, failed: 0 })
    expect(operations).toEqual(['enqueue', 'sync-claim', 'gc-claim'])
    expect(provider.close).toHaveBeenCalledTimes(2)
    expect(activeTransactions).toBe(0)
  })
})

describe('competing full backfills', () => {
  it('advances all four app cursors with one shared 800-operation provider budget', async () => {
    const storage = publicationProviders()
    const appIds = ['com.test.backfill-a', 'com.test.backfill-b', 'com.test.backfill-c', 'com.test.backfill-d']
    const continuations: string[] = []
    provider.execute.mockImplementation(async (client: Connection, query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('public.claim_serving_policy_sync_source('))
        return { rows: [] }
      if (statement.sql.includes('public.plugin_state_sync_enabled()'))
        return { rows: [{ enabled: true }] }
      if (statement.sql.includes('public.claim_plugin_state_sync('))
        return { rows: [{ result: { status: 'ok', lease_token: 'fixture-lease', generation: '1', has_more: false,
          apps: appIds.map(app_id => ({ app_id, jobs: [{ kind: 'full', ref: '' }], attempts: 1 })),
        } }] }
      if (statement.sql.includes('SELECT 1 AS found FROM public.apps')) {
        expect(client.inTransaction).toBe(true)
        return { rows: [{ found: 1 }] }
      }
      if (statement.sql.includes('FROM public.app_versions av')) {
        expect(client.inTransaction).toBe(true)
        const after = typeof statement.params[1] === 'string' ? Number(statement.params[1].slice(2)) + 1 : 0
        const limit = Number(statement.params.at(-1))
        return { rows: Array.from({ length: limit }, (_, index) => ({
          id: after + index, owner_org: 'fixture-org', name: `v-${String(after + index).padStart(5, '0')}`, deleted: false,
        })) }
      }
      if (statement.sql.includes('public.ack_plugin_state_sync_progress(')) {
        const match = /p_continuations\s*=>\s*\$(\d+)/.exec(statement.sql)
        if (!match)
          throw new Error('continuations were not sent atomically with ACK')
        const refs = JSON.parse(String(statement.params[Number(match[1]) - 1])) as Record<string, string>
        continuations.push(...Object.values(refs))
      }
      return { rows: [] }
    })
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async c => c.json(await drainPluginStateSync(c)))
    const response = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
    expect(await response.json()).toEqual({ claims: 1, apps: 4, failed: 0 })
    expect(continuations).toHaveLength(4)
    for (const ref of continuations) {
      const cursor = JSON.parse(ref)
      expect(cursor.p).toBe('versions')
      expect(Number(cursor.after.slice(2))).toBeGreaterThanOrEqual(47)
    }
    const operations = storage.namespace.put.mock.calls.length + storage.namespace.get.mock.calls.length
      + storage.namespace.list.mock.calls.length + storage.pointers.get.mock.calls.length + storage.pointers.put.mock.calls.length
      + storage.pointers.list.mock.calls.length
    expect(operations).toBeLessThanOrEqual(800)
    expect(peakTransactions).toBeLessThanOrEqual(4)
  })
})


describe('policy-only publication with payload sync disabled', () => {
  it.each([false, true])('retries an R2 failure without payload history or coverage ACKs with KV bound=%s', async (withNamespace) => {
    const storage = publicationProviders()
    const appId = 'com.example.policy-only'
    let claims = 0
    let available = true
    const acknowledgements: unknown[][] = []
    const statements: string[] = []
    provider.execute.mockImplementation(async (client: Connection, query: SQL) => {
      expect(client.inTransaction).toBe(true)
      const statement = dialect.sqlToQuery(query)
      statements.push(statement.sql)
      if (statement.sql.includes('public.claim_serving_policy_sync_source(')) {
        if (!available)
          return { rows: [] }
        available = false
        return { rows: [{ token: 'fixture-policy-lease', generation: String(++claims), app_id: appId, active_epoch: null }] }
      }
      if (statement.sql.includes('SELECT serving_regions, serving_region_mode FROM public.apps'))
        return { rows: [{ serving_regions: ['NA'], serving_region_mode: 'block' }] }
      if (statement.sql.includes('public.ack_serving_policy_sync(')) {
        acknowledgements.push(statement.params)
        return { rows: [] }
      }
      if (statement.sql.includes('public.plugin_state_sync_enabled()'))
        return { rows: [{ enabled: false }] }
      throw new Error('Unexpected payload query: ' + statement.sql)
    })
    storage.pointers.put.mockRejectedValueOnce(new Error('Synthetic R2 outage'))
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async c => c.json(await drainPluginStateSync(c)))
    const env = { PLUGIN_STATE_POINTERS: storage.pointers, ...(withNamespace ? { PLUGIN_STATE: storage.namespace } : {}) }
    expect(await (await app.request('/', { method: 'POST' }, env)).json()).toEqual({ claims: 1, apps: 0, failed: 1 })
    available = true // periodic tick recovers the durable job after its cooldown
    expect(await (await app.request('/', { method: 'POST' }, env)).json()).toEqual({ claims: 1, apps: 1, failed: 0 })
    expect(acknowledgements).toEqual([['fixture-policy-lease', false], ['fixture-policy-lease', true]])
    expect(storage.namespace.get).not.toHaveBeenCalled()
    expect(storage.namespace.put).not.toHaveBeenCalled()
    expect(storage.namespace.list).not.toHaveBeenCalled()
    expect(JSON.parse(storage.objects.get('sr1:' + appId)!.body)).toMatchObject({ generation: '2', policy: { mode: 'route', regions: expect.arrayContaining(['EU', 'NA']) } })
    expect(statements.some(value => /full_synced|app_synced|manifest|app_versions|ack_plugin_state/.test(value))).toBe(false)
  })
})


describe('policy and payload failure isolation', () => {
  it.each(['claim', 'ack'] as const)('continues payload publication after a policy %s failure', async (fault) => {
    const storage = publicationProviders()
    const appId = 'com.example.policy-payload-isolation'
    const statements: string[] = []
    provider.execute.mockImplementation(async (client: Connection, query: SQL) => {
      expect(client.inTransaction).toBe(true)
      const statement = dialect.sqlToQuery(query)
      statements.push(statement.sql)
      if (statement.sql.includes('public.claim_serving_policy_sync_source(')) {
        if (fault === 'claim')
          throw new Error('Synthetic policy epoch mismatch')
        return { rows: [{ token: 'policy-lease', generation: '1', app_id: appId, active_epoch: null }] }
      }
      if (statement.sql.includes('SELECT serving_regions, serving_region_mode FROM public.apps'))
        return { rows: [{ serving_regions: ['NA'], serving_region_mode: 'block' }] }
      if (statement.sql.includes('public.ack_serving_policy_sync('))
        throw new Error('Synthetic policy ACK failure')
      if (statement.sql.includes('public.plugin_state_sync_enabled()'))
        return { rows: [{ enabled: true }] }
      if (statement.sql.includes('public.claim_plugin_state_sync(')) {
        return { rows: [{ result: { status: 'ok', lease_token: 'payload-lease', generation: '2', has_more: false,
          apps: [{ app_id: appId, jobs: [{ kind: 'version', ref: '1.0.0' }], attempts: 1 }],
        } }] }
      }
      if (statement.sql.includes('FROM public.app_versions av'))
        return { rows: [{ id: 202, owner_org: 'fixture-org', name: '1.0.0', deleted: false }] }
      return { rows: [] }
    })
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async c => c.json(await drainPluginStateSync(c)))
    const response = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
    const expectedSuccesses = fault === 'ack' ? 2 : 1
    expect(await response.json()).toEqual({ claims: expectedSuccesses, apps: expectedSuccesses, failed: 1 })
    expect(storage.publishedValue(await pluginStateVersionKey(appId, '1.0.0'))).toMatchObject({ id: 202 })
    expect(statements.filter(value => value.includes('public.claim_plugin_state_sync('))).toHaveLength(1)
    expect(statements.filter(value => value.includes('public.ack_plugin_state_sync_progress('))).toHaveLength(1)
    expect(statements.filter(value => value.includes('public.claim_serving_policy_sync_source('))).toHaveLength(1)
    expect(provider.log).toHaveBeenCalledWith(expect.objectContaining({ message: 'serving policy sync drain failed' }))
  })
})


describe('policy and payload queue fairness', () => {
  it.each(['deadline', 'operations', 'failure'] as const)('publishes and acknowledges payloads on successive drains with a sustained policy %s backlog', async (limiter) => {
    const storage = publicationProviders()
    const appId = 'com.example.policy-backlog-payload'
    const names = ['1.0.0', '2.0.0', '3.0.0', '4.0.0']
    const completed: number[] = []
    if (limiter === 'failure') {
      const put = storage.pointers.put.getMockImplementation()!
      storage.pointers.put.mockImplementation(async (...args) => {
        if (args[0].startsWith('sr1:'))
          throw new Error('Synthetic persistent policy provider failure')
        return put(...args)
      })
    }
    let policyClaims = 0
    let payloadGeneration = 1000
    let now = 1_000_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    provider.execute.mockImplementation(async (client: Connection, query: SQL) => {
      expect(client.inTransaction).toBe(true)
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('public.claim_serving_policy_sync_source(')) {
        const generation = String(++policyClaims)
        return { rows: [{ token: `policy-lease-${generation}`, generation, app_id: `com.example.policy-backlog-${generation}`, active_epoch: null }] }
      }
      if (statement.sql.includes('SELECT serving_regions, serving_region_mode FROM public.apps')) {
        if (limiter === 'deadline')
          now += 1000
        return { rows: [{ serving_regions: ['EU'], serving_region_mode: 'route' }] }
      }
      if (statement.sql.includes('public.ack_serving_policy_sync('))
        return { rows: [] }
      if (statement.sql.includes('public.plugin_state_sync_enabled()'))
        return { rows: [{ enabled: true }] }
      if (statement.sql.includes('public.claim_plugin_state_sync(')) {
        return { rows: [{ result: { status: 'ok', lease_token: `payload-lease-${payloadGeneration}`, generation: String(payloadGeneration), has_more: false,
          apps: [{ app_id: appId, jobs: names.map(ref => ({ kind: 'version', ref })), attempts: 1 }],
        } }] }
      }
      if (statement.sql.includes('FROM public.app_versions av'))
        return { rows: names.map((name, index) => ({ id: payloadGeneration + index, owner_org: 'fixture-org', name, deleted: false })) }
      if (statement.sql.includes('public.ack_plugin_state_sync_progress(')) {
        const match = /p_done\s*=>\s*\$(\d+)/.exec(statement.sql)
        if (!match)
          throw new Error('payload completion was not sent with ACK')
        const done = statement.params[Number(match[1]) - 1]
        if (Array.isArray(done) && done.includes(appId))
          completed.push(payloadGeneration)
        return { rows: [] }
      }
      if (statement.sql.includes('public.claim_plugin_state_gc('))
        return { rows: [{ result: null }] }
      throw new Error(`unexpected fairness query: ${statement.sql}`)
    })
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async c => c.json(await drainPluginStateSync(c)))
    try {
      for (let pass = 0; pass < 2; pass++) {
        const operationsBefore = storage.namespace.put.mock.calls.length + storage.pointers.get.mock.calls.length + storage.pointers.put.mock.calls.length
        const policiesBefore = policyClaims
        const response = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
        expect(await response.json()).toMatchObject({ failed: limiter === 'failure' ? 1 : 0 })
        expect(completed).toContain(payloadGeneration)
        for (const [index, name] of names.entries())
          expect(storage.publishedValue(await pluginStateVersionKey(appId, name))).toMatchObject({ id: payloadGeneration + index })
        const operations = storage.namespace.put.mock.calls.length + storage.pointers.get.mock.calls.length + storage.pointers.put.mock.calls.length - operationsBefore
        expect(operations).toBeLessThanOrEqual(800)
        expect(policyClaims).toBeGreaterThan(policiesBefore)
        if (limiter === 'failure')
          expect(policyClaims - policiesBefore).toBe(1)
        expect(now).toBeLessThan(1_000_000 + (pass + 1) * 20_000)
        payloadGeneration += 1000
      }
      expect(completed).toEqual([1000, 2000])
      expect(activeTransactions).toBe(0)
    }
    finally {
      clock.mockRestore()
    }
  })
})


describe('policy publication iteration reservations', () => {
  it.each([10, 11])('requires all 11 possible provider operations before leasing with %i slots left', async (remaining) => {
    const storage = publicationProviders()
    const budget = { remaining }
    const result = { claims: 0, apps: 0, failed: 0 }
    const acknowledgements: unknown[][] = []
    storage.objects.set('sr1:ready', { etag: 'fixture-ready-etag', body: JSON.stringify({ f: 1, epoch: servingRegionReaderEpoch }) })
    const put = storage.pointers.put.getMockImplementation()!
    let attempts = 0
    storage.pointers.put.mockImplementation(async (...args) => ++attempts < 5 ? null : put(...args))
    provider.execute.mockImplementation(async (_client: Connection, query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('public.claim_serving_policy_sync_source('))
        return { rows: [{ token: 'fixture-policy-reservation', generation: '1', app_id: 'com.example.policy-reservation', active_epoch: servingRegionReaderEpoch }] }
      if (statement.sql.includes('SELECT serving_regions, serving_region_mode FROM public.apps'))
        return { rows: [{ serving_regions: ['EU'], serving_region_mode: 'route' }] }
      if (statement.sql.includes('public.ack_serving_policy_sync(')) {
        acknowledgements.push(statement.params)
        return { rows: [] }
      }
      throw new Error(`unexpected policy reservation query: ${statement.sql}`)
    })
    await inContext(async (c) => {
      const deadline = Date.now() + 10_000
      await drainServingPolicies(c, await getPgClient(c), storage.pointers, budget, deadline, result)
    })
    if (remaining === 10) {
      expect(provider.execute).not.toHaveBeenCalled()
      expect(result).toEqual({ claims: 0, apps: 0, failed: 0 })
      expect(budget.remaining).toBe(10)
    }
    else {
      expect(result).toEqual({ claims: 1, apps: 1, failed: 0 })
      expect(acknowledgements).toEqual([['fixture-policy-reservation', true]])
      expect(storage.pointers.get).toHaveBeenCalledTimes(6)
      expect(storage.pointers.put).toHaveBeenCalledTimes(5)
      expect(budget.remaining).toBe(0)
    }
  })

  it('bounds claims for deleted policy rows that use no provider operations', async () => {
    const storage = publicationProviders()
    const budget = { remaining: 22 }
    const result = { claims: 0, apps: 0, failed: 0 }
    let claims = 0
    provider.execute.mockImplementation(async (_client: Connection, query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('public.claim_serving_policy_sync_source(')) {
        if (++claims > 2)
          throw new Error('policy no-op claim limit exceeded')
        return { rows: [{ token: `fixture-deleted-policy-${claims}`, generation: String(claims), app_id: `com.example.deleted-policy-${claims}`, active_epoch: null }] }
      }
      if (statement.sql.includes('SELECT serving_regions, serving_region_mode FROM public.apps') || statement.sql.includes('public.ack_serving_policy_sync('))
        return { rows: [] }
      throw new Error(`unexpected deleted policy query: ${statement.sql}`)
    })
    await inContext(async (c) => {
      const deadline = Date.now() + 10_000
      await drainServingPolicies(c, await getPgClient(c), storage.pointers, budget, deadline, result)
    })
    expect(result).toEqual({ claims: 2, apps: 2, failed: 0 })
    expect(budget.remaining).toBe(22)
    expect(storage.pointers.get).not.toHaveBeenCalled()
    expect(storage.pointers.put).not.toHaveBeenCalled()
  })
})


describe('EU source deferral and inventory', () => {
  function ackArguments(statement: ReturnType<typeof dialect.sqlToQuery>) {
    return Object.fromEntries([...statement.sql.matchAll(/(p_\w+)\s*=>\s*\$(\d+)/g)].map(match => [match[1], statement.params[Number(match[2]) - 1]]))
  }

  it('batches primary bookkeeping and preserves each app status without reading source rows there', async () => {
    const storage = publicationProviders()
    const appIds = ['com.example.pending-history', 'com.example.finished-history']
    const bookkeeping = vi.fn()
    const ack = vi.fn()
    let claims = 0
    provider.select.mockImplementation((client: Connection) => {
      expect(client.id).toBeGreaterThan(0)
      return { from: () => ({ where: () => ({ leftJoin: () => ({ limit: async () => [] }) }) }) }
    })
    provider.execute.mockImplementation(async (client: Connection, query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('claim_serving_policy_sync_source'))
        return { rows: [] }
      if (statement.sql.includes('plugin_state_sync_enabled'))
        return { rows: [{ enabled: true }] }
      if (statement.sql.includes('claim_plugin_state_sync(')) {
        if (++claims > 1)
          return { rows: [{ result: { status: 'empty' } }] }
        return { rows: [{ result: { status: 'ok', lease_token: 'fixture-lease', generation: '2', has_more: false,
          apps: appIds.map(app_id => ({ app_id, jobs: [{ kind: 'app', ref: '' }], attempts: 1 })),
        } }] }
      }
      if (statement.sql.includes('public.plugin_state_sync_apps')) {
        expect(client.id).toBe(0)
        bookkeeping(statement.params)
        return { rows: appIds.map((app_id, index) => ({ app_id, fully_synced: index === 1, pending_full: index === 0, archived_full: false })) }
      }
      if (statement.sql.includes('FROM public.apps')) {
        expect(client.id).toBeGreaterThan(0)
        return { rows: [] }
      }
      if (statement.sql.includes('ack_plugin_state_sync_progress')) {
        ack(ackArguments(statement))
        return { rows: [] }
      }
      if (statement.sql.includes('claim_plugin_state_gc'))
        return { rows: [{ result: null }] }
      throw new Error(`unexpected query: ${statement.sql}`)
    })
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async c => c.json(await drainPluginStateSync(c)))
    const response = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
    expect(await response.json()).toEqual({ claims: 1, apps: 2, failed: 0 })
    expect(bookkeeping).toHaveBeenCalledExactlyOnceWith([appIds])
    expect(provider.select).toHaveBeenCalledTimes(2)
    expect(provider.connect.mock.calls.slice(1).every(call => call[1] === 'eu-replica')).toBe(true)
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({
      p_done: appIds, p_continuations: JSON.stringify({ [appIds[1]]: '' }),
    }))
  })

  it.each(['lag', 'missing-marker', 'connection-failure', 'missing-barrier'])('preserves every full cursor/key without publication or completion ACK on %s', async (failure) => {
    const storage = publicationProviders()
    const ack = vi.fn()
    const appId = 'com.example.replica-defer'
    if (failure === 'lag')
      provider.marker.mockResolvedValue({ rows: [{ ready: false }] })
    if (failure === 'missing-marker')
      provider.marker.mockResolvedValue({ rows: [] })
    if (failure === 'connection-failure') {
      provider.connect.mockImplementation(async (_c?: unknown, route?: boolean | 'eu-replica') => {
        if (route === 'eu-replica')
          throw new Error('synthetic replica outage')
        return { id: nextConnection++, inTransaction: false }
      })
    }
    provider.execute.mockImplementation(async (_client: Connection, query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('claim_serving_policy_sync_source'))
        return { rows: [] }
      if (statement.sql.includes('plugin_state_sync_enabled'))
        return { rows: [{ enabled: true }] }
      if (statement.sql.includes('claim_plugin_state_sync(')) {
        return { rows: [{ result: { status: 'ok', lease_token: 'fixture-lease', generation: '2', has_more: false,
          apps: [{ app_id: appId, jobs: [{ kind: 'full', ref: '{"p":"versions","after":"old"}' }, { kind: 'manifest', ref: '10' }], attempts: 5 }],
        } }] }
      }
      if (statement.sql.includes('ack_plugin_state_sync_progress')) {
        ack(ackArguments(statement))
        return { rows: [] }
      }
      if (statement.sql.includes('claim_plugin_state_gc'))
        return { rows: [{ result: null }] }
      throw new Error(`unexpected source access: ${statement.sql}`)
    })
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async c => c.json(await drainPluginStateSync(c)))
    // Missing barriers are also checked directly, without the claim-fixture default.
    if (failure === 'missing-barrier') {
      await inContext(async (c) => {
        const source = createPluginStateSourceReader(c, Date.now() + 10_000, '')
        await expect(source.read(async () => 'unsafe')).rejects.toThrow('EU plugin state source unavailable')
      })
      expect(provider.connect).not.toHaveBeenCalled()
      return
    }
    const response = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
    expect(await response.json()).toEqual({ claims: 1, apps: 0, failed: 0 })
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({
      p_done: [], p_failed: [], p_deferred: [appId], p_full_done: [], p_removed: [],
      p_changed_apps: [], p_continuations: '{}', p_completed: '{}',
    }))
    expect(storage.namespace.put).not.toHaveBeenCalled()
    expect(storage.pointers.put).not.toHaveBeenCalled()
    expect(provider.connect.mock.calls.filter(call => call.length < 2)).toHaveLength(1)
    expect(provider.log).toHaveBeenCalledWith(expect.objectContaining({
      message: 'plugin state source deferred', app_id: appId, error: expect.any(Error),
    }))
  })

  it('settles only a proven version key when a later manifest snapshot loses its replica', async () => {
    const storage = publicationProviders()
    const appId = 'com.example.replica-partial'
    const ack = vi.fn()
    provider.marker.mockResolvedValueOnce({ rows: [{ ready: true }] }).mockResolvedValue({ rows: [{ ready: false }] })
    provider.execute.mockImplementation(async (_client: Connection, query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('claim_serving_policy_sync_source'))
        return { rows: [] }
      if (statement.sql.includes('plugin_state_sync_enabled'))
        return { rows: [{ enabled: true }] }
      if (statement.sql.includes('claim_plugin_state_sync('))
        return { rows: [{ result: { status: 'ok', lease_token: 'fixture-lease', generation: '2', has_more: false,
          apps: [{ app_id: appId, jobs: [{ kind: 'version', ref: '1.0.0' }, { kind: 'manifest', ref: '10' }], attempts: 1 }],
        } }] }
      if (statement.sql.includes('FROM public.app_versions av'))
        return { rows: [{ id: 10, owner_org: 'fixture-org', name: '1.0.0', deleted: false }] }
      if (statement.sql.includes('ack_plugin_state_sync_progress')) {
        ack(ackArguments(statement))
        return { rows: [] }
      }
      if (statement.sql.includes('claim_plugin_state_gc'))
        return { rows: [{ result: null }] }
      throw new Error(`unexpected query: ${statement.sql}`)
    })
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async c => c.json(await drainPluginStateSync(c)))
    await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({
      p_done: [], p_failed: [], p_deferred: [appId],
      p_completed: JSON.stringify({ [appId]: [{ kind: 'version', ref: '1.0.0' }] }),
    }))
    expect(storage.publishedValue(await pluginStateVersionKey(appId, '1.0.0'))).toMatchObject({ id: 10 })
  })

  it.each([false, true])('commits inventory only after the same EU snapshot proves its barrier, ready=%s', async (ready) => {
    provider.inventory.mockResolvedValue({ rows: [{ page: { after: 'com.example.a', required_commit_at: barrier, epoch: null, known_ids: ['com.example.deleted'] } }] })
    provider.marker.mockResolvedValue({ rows: [{ ready }] })
    const commit = vi.fn()
    provider.execute.mockImplementation(async (client: Connection, query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('FROM public.apps')) {
        expect(client.inTransaction).toBe(true)
        expect(provider.marker).toHaveBeenCalledWith(client, expect.anything())
        expect(statement.params).toEqual(['com.example.a', 25, ['com.example.deleted'], 25])
        return { rows: [{ app_id: 'com.example.b' }, { app_id: 'com.example.deleted' }] }
      }
      if (statement.sql.includes('commit_plugin_state_inventory')) {
        commit(statement.params)
        return { rows: [] }
      }
      throw new Error(`unexpected inventory query: ${statement.sql}`)
    })
    await inContext(async (c) => {
      await inventoryPluginState(c, await getPgClient(c), Date.now() + 10_000, 'payload')
    })
    if (ready)
      expect(commit).toHaveBeenCalledWith(['payload', 'com.example.a', barrier, null, ['com.example.b', 'com.example.deleted']])
    else
      expect(commit).not.toHaveBeenCalled()
    expect(provider.connect.mock.calls.at(-1)?.[1]).toBe('eu-replica')
  })
})
