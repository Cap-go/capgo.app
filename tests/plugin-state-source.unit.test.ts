import type { SQL } from 'drizzle-orm'
import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { PgDialect } from 'drizzle-orm/pg-core'
import { Hono } from 'hono/tiny'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pluginStateVersionKey } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'
import { buildManifestDoc, createPluginStateSourceReader, drainPluginStateSync } from '../supabase/functions/_backend/triggers/plugin_state_sync.ts'
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
  provider.transaction.mockImplementation(async <T>(client: Connection, run: (client: Connection) => Promise<T>, options: { appendSql?: string }) => {
    expect(client.inTransaction).toBe(false)
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
  it('publishes the fresh primary row and commits before provider I/O or ACK', async () => {
    const storage = publicationProviders()
    let claims = 0
    provider.execute.mockImplementation(async (client: Connection, query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('public.claim_plugin_state_sync(')) {
        expect(client.inTransaction).toBe(false)
        claims++
        return { rows: [{ result: { status: 'ok', lease_token: 'fixture-lease', generation: '1', has_more: false,
          apps: [{ app_id: 'com.test.freshsnapshot', jobs: [{ kind: 'version', ref: '1.0.0' }], attempts: 1 }],
        } }] }
      }
      if (statement.sql.includes('FROM public.app_versions av')) {
        // Plain queries emulate a previously warmed Hyperdrive result.
        return { rows: [{ id: client.inTransaction ? 202 : 101, owner_org: 'fixture-org', name: '1.0.0', deleted: false }] }
      }
      expect(client.inTransaction).toBe(false)
      expect(activeTransactions).toBe(0)
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
    expect(provider.transaction).toHaveBeenCalledTimes(1)
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
