import type { SQL } from 'drizzle-orm'
import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { PgDialect } from 'drizzle-orm/pg-core'
import { Hono } from 'hono/tiny'
import { describe, expect, it, vi } from 'vitest'
import { publicationProviders } from './plugin-state-publication-fixture.ts'
import { pluginStateAppKey, pluginStateDeviceKey, pluginStateVersionKey } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'
import { createPluginStateSyncStore, drainPluginStateSync } from '../supabase/functions/_backend/triggers/plugin_state_sync.ts'

const provider = vi.hoisted(() => ({
  execute: vi.fn(),
  close: vi.fn(),
  log: vi.fn(),
}))

// The SQL and KV services are external boundaries. The real drain, app
// dispatch, per-invocation key deduplication and ACK construction all run.
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: async () => ({}),
  getDrizzleClient: () => ({ execute: provider.execute }),
  closeClient: provider.close,
  withPgTransaction: async <T>(client: unknown, run: (client: unknown) => Promise<T>) => run(client),
}))
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: provider.log,
  cloudlogErr: provider.log,
  serializeError: (error: unknown) => error,
}))

interface Statement {
  sql: string
  params: unknown[]
}

function argument(statement: Statement, name: string) {
  const match = new RegExp(`${name}\\s*=>\\s*\\$(\\d+)`).exec(statement.sql)
  if (!match)
    throw new Error(`SQL argument ${name} was not sent to the provider`)
  return statement.params[Number(match[1]) - 1]
}

describe('plugin state same-app reclaim', () => {
  it('writes a later same-app claim under its own fresh publication generation', async () => {
    const appId = 'com.test.reclaim'
    const bundleName = '1.0.0'
    const dialect = new PgDialect()
    const acks: Statement[] = []
    let claimCount = 0
    let versionReads = 0
    provider.execute.mockImplementation(async (query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('public.claim_plugin_state_sync(')) {
        claimCount++
        return { rows: [{ result: {
          status: 'ok',
          lease_token: `lease-${claimCount}`,
          generation: String(claimCount),
          has_more: claimCount === 1,
          apps: [{ app_id: appId, jobs: [{ kind: 'version', ref: bundleName }], attempts: 1 }],
        } }] }
      }
      if (statement.sql.includes('FROM public.app_versions av')) {
        versionReads++
        return { rows: [{ id: versionReads === 1 ? 101 : 202, owner_org: 'fixture-org', name: bundleName, deleted: false }] }
      }
      if (statement.sql.includes('public.ack_plugin_state_sync('))
        acks.push(statement)
      return { rows: [] }
    })

    const storage = publicationProviders()
    const put = storage.namespace.put
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async (c) => {
      c.set('requestId', 'plugin-state-reclaim-test')
      return c.json(await drainPluginStateSync(c))
    })

    const first = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
    expect(await first.json()).toEqual({ claims: 2, apps: 2, failed: 0 })
    expect(versionReads).toBe(2)
    expect(put).toHaveBeenCalledTimes(2)
    expect(storage.publishedValue(await pluginStateVersionKey(appId, bundleName))).toMatchObject({ id: 202 })
    expect(argument(acks[0], 'p_done')).toEqual([appId])
    expect(argument(acks[0], 'p_deferred')).toEqual([])
    expect(argument(acks[1], 'p_done')).toEqual([appId])
    expect(argument(acks[1], 'p_failed')).toEqual([])
    expect(argument(acks[1], 'p_deferred')).toEqual([])
    expect(provider.close).toHaveBeenCalledTimes(3)
  })
  it('retries an empty cooldown claim within the same bounded drain', async () => {
    const storage = publicationProviders()
    let claims = 0
    const dialect = new PgDialect()
    provider.execute.mockImplementation(async (query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('public.claim_plugin_state_sync(')) {
        claims++
        return { rows: [{ result: claims === 1 ? { status: 'empty', retry_after_ms: 5 } : {
          status: 'ok', lease_token: 'fixture-lease', generation: '1', has_more: false,
          apps: [{ app_id: 'com.test.cooldown', jobs: [{ kind: 'version', ref: '1.0.0' }], attempts: 1 }],
        } }] }
      }
      if (statement.sql.includes('FROM public.app_versions av'))
        return { rows: [{ id: 100, owner_org: 'fixture-org', name: '1.0.0', deleted: false }] }
      return { rows: [] }
    })
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async c => c.json(await drainPluginStateSync(c, { budgetMs: 1000 })))
    const response = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
    expect(await response.json()).toEqual({ claims: 1, apps: 1, failed: 0 })
    expect(claims).toBe(2)
    expect(storage.publishedValue(await pluginStateVersionKey('com.test.cooldown', '1.0.0'))).toMatchObject({ id: 100 })
  })

  it('defers a new device job while its full continuation is waiting in backoff', async () => {
    const storage = publicationProviders()
    const acks: Statement[] = []
    const dialect = new PgDialect()
    provider.execute.mockImplementation(async (query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('public.claim_plugin_state_sync('))
        return { rows: [{ result: { status: 'ok', lease_token: 'fixture-lease', generation: '1', has_more: false,
          apps: [{ app_id: 'com.test.full-backoff', jobs: [{ kind: 'device', ref: 'fixture-device' }], attempts: 1 }],
        } }] }
      if (statement.sql.includes('FROM public.plugin_state_sync_apps'))
        return { rows: [{ fully_synced: true, pending_full: true, archived_full: false }] }
      if (statement.sql.includes('public.ack_plugin_state_sync('))
        acks.push(statement)
      return { rows: [] }
    })
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async c => c.json(await drainPluginStateSync(c)))
    const response = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
    expect(await response.json()).toEqual({ claims: 1, apps: 0, failed: 0 })
    expect(argument(acks[0], 'p_deferred')).toEqual(['com.test.full-backoff'])
    expect(argument(acks[0], 'p_continuations')).toBe('{}')
    expect(storage.namespace.put).not.toHaveBeenCalled()
    expect(storage.pointers.put).not.toHaveBeenCalled()
  })

  it('queues a conservative purge when retrying already-published identical content', async () => {
    const appId = 'com.test.retry-purge'
    const storage = publicationProviders()
    const key = await pluginStateVersionKey(appId, '1.0.0')
    const value = { id: 100, owner_org: 'fixture-org', deleted: false }
    await createPluginStateSyncStore(storage.namespace, storage.pointers, '1').putJson(key, value)
    const acks: Statement[] = []
    const dialect = new PgDialect()
    provider.execute.mockImplementation(async (query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('public.claim_plugin_state_sync('))
        return { rows: [{ result: { status: 'ok', lease_token: 'retry-lease', generation: '2', has_more: false,
          apps: [{ app_id: appId, jobs: [{ kind: 'version', ref: '1.0.0' }], attempts: 2 }],
        } }] }
      if (statement.sql.includes('FROM public.app_versions av'))
        return { rows: [{ ...value, name: '1.0.0' }] }
      if (statement.sql.includes('public.ack_plugin_state_sync('))
        acks.push(statement)
      return { rows: [] }
    })
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async c => c.json(await drainPluginStateSync(c)))
    const response = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
    expect(await response.json()).toEqual({ claims: 1, apps: 1, failed: 0 })
    expect(storage.publishedValue(key)).toEqual(value)
    expect(argument(acks[0], 'p_changed_apps')).toEqual([appId])
  })

  it('publishes only the changed device key while a full scan remains archived', async () => {
    const appId = 'com.test.archived-full'
    const storage = publicationProviders()
    const acks: Statement[] = []
    const dialect = new PgDialect()
    provider.execute.mockImplementation(async (query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('public.claim_plugin_state_sync('))
        return { rows: [{ result: { status: 'ok', lease_token: 'device-lease', generation: '1', has_more: false,
          apps: [{ app_id: appId, jobs: [{ kind: 'device', ref: 'fixture-device' }], attempts: 1 }],
        } }] }
      if (statement.sql.includes('FROM public.plugin_state_sync_apps'))
        return { rows: [{ fully_synced: false, pending_full: false, archived_full: true }] }
      if (statement.sql.includes('public.ack_plugin_state_sync('))
        acks.push(statement)
      return { rows: [] }
    })
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async c => c.json(await drainPluginStateSync(c)))
    const response = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
    expect(await response.json()).toEqual({ claims: 1, apps: 1, failed: 0 })
    expect(storage.publishedValue(await pluginStateDeviceKey(appId, 'fixture-device'))).toEqual({ channel_id: null })
    expect(storage.objects.has(await pluginStateAppKey(appId))).toBe(false)
    expect(argument(acks[0], 'p_continuations')).toBe('{}')
    expect(argument(acks[0], 'p_full_done')).toEqual([])
  })

})
