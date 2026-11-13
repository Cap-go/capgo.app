import type { SQL } from 'drizzle-orm'
import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { PgDialect } from 'drizzle-orm/pg-core'
import { Hono } from 'hono/tiny'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pluginStateVersionKey } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'
import { app as syncApp, buildManifestDoc, createPluginStateSourceReader, drainPluginStateSync } from '../supabase/functions/_backend/triggers/plugin_state_sync.ts'
import { publicationProviders } from './plugin-state-publication-fixture.ts'

interface Connection { id: number, inTransaction: boolean }

const provider = vi.hoisted(() => ({
  connect: vi.fn<() => Promise<Connection>>(),
  execute: vi.fn(),
  transaction: vi.fn(),
  close: vi.fn(),
  log: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: provider.connect,
  getDrizzleClient: (client: Connection) => ({ execute: (query: SQL) => provider.execute(client, query) }),
  withPgTransaction: provider.transaction,
  closeClient: provider.close,
}))
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: provider.log,
  cloudlogErr: provider.log,
  serializeError: (error: unknown) => error,
}))

const dialect = new PgDialect()
let activeTransactions = 0
let peakTransactions = 0
let nextConnection = 0

beforeEach(() => {
  vi.clearAllMocks()
  activeTransactions = 0
  peakTransactions = 0
  nextConnection = 0
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
    expect(provider.transaction).toHaveBeenCalledTimes(4)
    expect(provider.close).toHaveBeenCalledTimes(2)
  })

  it('uses separate handles and caps concurrent source snapshots at four', async () => {
    await inContext(async (c) => {
      const source = createPluginStateSourceReader(c, Date.now() + 10_000)
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
      const source = createPluginStateSourceReader(c, Date.now() + 10_000)
      const ready = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let active = 0
      let peak = 0
      let started = 0
      const all = Promise.all(Array.from({ length: 8 }, () => source.manifest(async () => {
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
      if (statement.sql.includes('AS estimated_bytes'))
        return { rows: [{ estimated_bytes: 5 * 1024 * 1024 }] }
      if (statement.sql.includes('FROM public.app_versions av'))
        return { rows: [{ id: 202, app_id: 'com.test.freshsnapshot', deleted: false }] }
      throw new Error('manifest rows should not be loaded after the memory preflight')
    })
    await inContext(async (c) => {
      const source = createPluginStateSourceReader(c, Date.now() + 10_000)
      expect(await buildManifestDoc(source, 202)).toMatchObject({
        f: 1, version_id: 202, app_id: 'com.test.freshsnapshot', fallback: 'replica', reason: 'worker_memory_limit',
      })
      expect(provider.execute).toHaveBeenCalledTimes(2)
      expect(activeTransactions).toBe(0)
    })
  })

  it('releases the checked-out handle when a source snapshot fails', async () => {
    await inContext(async (c) => {
      const source = createPluginStateSourceReader(c, Date.now() + 10_000)
      await expect(source.read(async () => { throw new Error('synthetic source failure') })).rejects.toThrow('synthetic source failure')
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
      if (statement.sql.includes('public.claim_plugin_state_sync(')) {
        if (!client.inTransaction) {
          // Stop a broken drain quickly after demonstrating replay of an old lease.
          if (++cachedClaims > 2)
            throw new Error('cached mutation claim repeated after its ACK')
          return { rows: [{ result: cachedFirstClaim }] }
        }
        return { rows: [{ result: completed < names.length ? claimResult(completed) : { status: 'empty' } }] }
      }
      if (statement.sql.includes('public.ack_plugin_state_sync(')) {
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
      if (statement.sql.includes('public.ack_plugin_state_sync(')) {
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
