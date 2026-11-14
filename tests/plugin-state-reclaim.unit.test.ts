import type { SQL } from 'drizzle-orm'
import type { PluginStateAppDoc, PluginStateChannelRow } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'
import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { PgDialect } from 'drizzle-orm/pg-core'
import { Hono } from 'hono/tiny'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { publicationProviders } from './plugin-state-publication-fixture.ts'
import { pluginStateAppKey, pluginStateDeviceKey, pluginStateManifestKey, pluginStateVersionKey } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'
import { createPluginStateSyncStore, drainPluginStateSync } from '../supabase/functions/_backend/triggers/plugin_state_sync.ts'

const provider = vi.hoisted(() => ({
  execute: vi.fn(),
  close: vi.fn(),
  log: vi.fn(),
  owner: vi.fn(),
  channels: vi.fn(),
  channelListIds: vi.fn(),
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
vi.mock('../supabase/functions/_backend/plugin_runtime/utils/pluginStateSelects.ts', () => ({
  selectPluginStateOwner: provider.owner,
  selectPluginStateChannels: provider.channels,
  selectPluginStateChannelListIds: provider.channelListIds,
}))

beforeEach(() => {
  vi.clearAllMocks()
  provider.owner.mockResolvedValue(null)
  provider.channels.mockResolvedValue([])
  provider.channelListIds.mockResolvedValue([])
})

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
  it('settles a deadline-limited prefix so successive leases reach the full cursor', async () => {
    const appId = 'com.test.partial-progress'
    const storage = publicationProviders()
    const dialect = new PgDialect()
    const acks: Statement[] = []
    let now = 1_000_000
    let generation = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const cursor = JSON.stringify({ p: 'versions', after: null })
    let jobs = [
      { kind: 'version', ref: '1.0.0' },
      ...Array.from({ length: 46 }, (_, index) => ({ kind: 'manifest', ref: String(index + 1) })),
      { kind: 'full', ref: cursor },
    ]
    provider.execute.mockImplementation(async (query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('public.claim_plugin_state_sync('))
        return { rows: [{ result: { status: 'ok', lease_token: `lease-${++generation}`, generation: String(generation), has_more: false,
          apps: [{ app_id: appId, jobs, attempts: 1 }],
        } }] }
      if (statement.sql.includes('WHERE av.id =')) {
        now += 1000
        return { rows: [{ id: statement.params[0], app_id: appId, deleted: false }] }
      }
      if (statement.sql.includes('SELECT 1 AS found'))
        return { rows: [{ found: 1 }] }
      if (statement.sql.includes('ORDER BY av.name'))
        return { rows: [] }
      if (statement.sql.includes('WHERE av.app_id ='))
        return { rows: [{ id: 101, name: '1.0.0', owner_org: 'fixture-org', deleted: false }] }
      if (statement.sql.includes('public.ack_plugin_state_sync_progress(')) {
        acks.push(statement)
        const completed = JSON.parse(String(argument(statement, 'p_completed')))[appId] ?? []
        const done = argument(statement, 'p_done')
        jobs = Array.isArray(done) && done.includes(appId)
          ? []
          : jobs.filter(job => !completed.some((key: { kind: string, ref: string }) => key.kind === job.kind && key.ref === job.ref))
      }
      return { rows: [] }
    })
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async c => c.json(await drainPluginStateSync(c, { budgetMs: 8000 })))
    try {
      for (let lease = 1; lease <= 10 && jobs.length > 0; lease++) {
        const response = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
        expect(await response.json()).toMatchObject({ claims: 1, failed: 0 })
        // The version prefix is never republished after its first live ACK.
        expect(JSON.parse(storage.objects.get(await pluginStateVersionKey(appId, '1.0.0'))!.body).generation).toBe('1')
        if (lease === 1) {
          expect(argument(acks[0], 'p_deferred')).toEqual([appId])
          expect(jobs.find(job => job.kind === 'full')?.ref).toBe(cursor)
          expect(jobs.filter(job => job.kind === 'manifest')).toHaveLength(38)
        }
      }
      expect(jobs).toEqual([])
      expect(acks).toHaveLength(6)
      expect(storage.publishedValue(pluginStateManifestKey(46))).not.toBeNull()
      expect(storage.namespace.put).toHaveBeenCalledTimes(48) // version, 46 manifests, final app
      expect(argument(acks.at(-1)!, 'p_done')).toEqual([appId])
      expect(provider.log).toHaveBeenCalledWith(expect.objectContaining({ claims: 1, apps: 0, failed: 0 }))
    }
    finally {
      clock.mockRestore()
    }
  })

  it('settles published keys across shared-capacity deferrals without acknowledging an unfinished key', async () => {
    const storage = publicationProviders()
    const dialect = new PgDialect()
    const acks: Statement[] = []
    let generation = 1
    const jobsByApp = new Map(Array.from({ length: 4 }, (_, index) => [
      `com.test.capacity-progress.${index}`,
      [
        { kind: 'version', ref: '1.0.0' },
        ...Array.from({ length: 46 }, (_, offset) => ({ kind: 'manifest', ref: String(index * 1000 + offset + 1) })),
        { kind: 'full', ref: JSON.stringify({ p: 'versions', after: null }) },
      ],
    ]))
    const contended = new Set<string>()
    const put = storage.pointers.put.getMockImplementation()!
    storage.pointers.put.mockImplementation(async (key, body, options) => {
      // A competing older write wins the first CAS for each key. The real
      // publisher rereads the pointer and spends the shared operation budget.
      if (!contended.has(key)) {
        contended.add(key)
        await put(key, JSON.stringify({ f: 1, generation: '1', kvKey: null }), options)
        return null
      }
      return put(key, body, options)
    })
    provider.execute.mockImplementation(async (query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('public.claim_plugin_state_sync('))
        return { rows: [{ result: { status: 'ok', lease_token: `lease-${++generation}`, generation: String(generation), has_more: false,
          apps: [...jobsByApp].filter(([, jobs]) => jobs.length > 0).map(([app_id, jobs]) => ({ app_id, jobs, attempts: 1 })),
        } }] }
      if (statement.sql.includes('WHERE av.id ='))
        return { rows: [{ id: statement.params[0], app_id: `com.test.capacity-progress.${Math.floor(Number(statement.params[0]) / 1000)}`, deleted: false }] }
      if (statement.sql.includes('SELECT 1 AS found'))
        return { rows: [{ found: 1 }] }
      if (statement.sql.includes('ORDER BY av.name'))
        return { rows: [] }
      if (statement.sql.includes('WHERE av.app_id ='))
        return { rows: [{ id: 101, name: '1.0.0', owner_org: 'fixture-org', deleted: false }] }
      if (statement.sql.includes('public.ack_plugin_state_sync_progress(')) {
        acks.push(statement)
        const completedByApp = JSON.parse(String(argument(statement, 'p_completed')))
        const done = argument(statement, 'p_done')
        for (const [appId, jobs] of jobsByApp) {
          const completed: { kind: string, ref: string }[] = completedByApp[appId] ?? []
          // Every proposed partial key really reached the current pointer.
          for (const key of completed) {
            const logical = key.kind === 'version' ? await pluginStateVersionKey(appId, key.ref) : pluginStateManifestKey(Number(key.ref))
            expect(JSON.parse(storage.objects.get(logical)!.body).generation).toBe(String(generation))
          }
          jobsByApp.set(appId, Array.isArray(done) && done.includes(appId)
            ? []
            : jobs.filter(job => !completed.some(key => key.kind === job.kind && key.ref === job.ref)))
        }
      }
      return { rows: [] }
    })
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async c => c.json(await drainPluginStateSync(c)))
    for (let lease = 0; lease < 3 && [...jobsByApp.values()].some(jobs => jobs.length > 0); lease++) {
      const response = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
      expect(await response.json()).toMatchObject({ failed: 0 })
    }
    expect([...jobsByApp.values()].every(jobs => jobs.length === 0)).toBe(true)
    expect(acks.length).toBeGreaterThan(1)
    expect(acks.some(ack => JSON.stringify(argument(ack, 'p_deferred')) !== '[]')).toBe(true)
    for (let index = 0; index < 4; index++)
      expect(JSON.parse(storage.objects.get(await pluginStateVersionKey(`com.test.capacity-progress.${index}`, '1.0.0'))!.body).generation).toBe('2')
  })

  it.each([false, true])('reports only confirmed partial writes when a later provider operation fails (fenced prefix: %s)', async (fenced) => {
    const appId = 'com.test.failed-progress'
    const storage = publicationProviders()
    const versionKey = await pluginStateVersionKey(appId, '1.0.0')
    if (fenced)
      await createPluginStateSyncStore(storage.namespace, storage.pointers, '3').putJson(versionKey, { id: 303, deleted: false })
    storage.namespace.put.mockRejectedValueOnce(new Error('test provider unavailable'))
    // A version is a tombstone, so its successful publication needs no KV PUT;
    // the subsequent manifest PUT fails after its source snapshot was built.
    const acks: Statement[] = []
    const dialect = new PgDialect()
    provider.execute.mockImplementation(async (query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('public.claim_plugin_state_sync('))
        return { rows: [{ result: { status: 'ok', lease_token: 'failed-lease', generation: '2', has_more: false,
          apps: [{ app_id: appId, jobs: [{ kind: 'version', ref: '1.0.0' }, { kind: 'manifest', ref: '101' }], attempts: 5 }],
        } }] }
      if (statement.sql.includes('WHERE av.id ='))
        return { rows: [{ id: 101, app_id: appId, deleted: false }] }
      if (statement.sql.includes('public.ack_plugin_state_sync_progress('))
        acks.push(statement)
      return { rows: [] }
    })
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async c => c.json(await drainPluginStateSync(c)))
    const response = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
    expect(await response.json()).toEqual({ claims: 1, apps: 0, failed: 1 })
    expect(argument(acks[0], 'p_completed')).toBe(JSON.stringify(fenced ? {} : { [appId]: [{ kind: 'version', ref: '1.0.0' }] }))
    expect(argument(acks[0], 'p_failed')).toEqual([appId])
    expect(argument(acks[0], 'p_deferred')).toEqual([])
    expect(storage.objects.has(pluginStateManifestKey(101))).toBe(false)
    if (fenced)
      expect(storage.publishedValue(versionKey)).toMatchObject({ id: 303 })
  })

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
      if (statement.sql.includes('public.ack_plugin_state_sync_progress('))
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
    expect(argument(acks[0], 'p_app_published')).toEqual([])
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

  it('publishes new device state without restarting a full continuation waiting in backoff', async () => {
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
      if (statement.sql.includes('public.ack_plugin_state_sync_progress('))
        acks.push(statement)
      return { rows: [] }
    })
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async c => c.json(await drainPluginStateSync(c)))
    const response = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
    expect(await response.json()).toEqual({ claims: 1, apps: 1, failed: 0 })
    expect(argument(acks[0], 'p_done')).toEqual(['com.test.full-backoff'])
    expect(argument(acks[0], 'p_deferred')).toEqual([])
    expect(argument(acks[0], 'p_continuations')).toBe('{}')
    expect(argument(acks[0], 'p_full_done')).toEqual([])
    expect(storage.publishedValue(await pluginStateDeviceKey('com.test.full-backoff', 'fixture-device'))).toEqual({ channel_id: null })
    expect(storage.publishedValue(await pluginStateAppKey('com.test.full-backoff'))).toMatchObject({ exists: false })
    expect(argument(acks[0], 'p_app_published')).toEqual(['com.test.full-backoff'])
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
      if (statement.sql.includes('public.ack_plugin_state_sync_progress('))
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

  it('does not report app publication when a newer generation fences the write', async () => {
    const appId = 'com.test.fenced-app-publication'
    const storage = publicationProviders()
    const key = await pluginStateAppKey(appId)
    await createPluginStateSyncStore(storage.namespace, storage.pointers, '2').putJson(key, {
      f: 1, app_id: appId, built_at: 2, exists: false,
    })
    const dialect = new PgDialect()
    const acks: Statement[] = []
    provider.execute.mockImplementation(async (query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (statement.sql.includes('public.claim_plugin_state_sync('))
        return { rows: [{ result: { status: 'ok', lease_token: 'old-lease', generation: '1', has_more: false,
          apps: [{ app_id: appId, jobs: [{ kind: 'app', ref: '' }], attempts: 1 }],
        } }] }
      if (statement.sql.includes('FROM public.plugin_state_sync_apps'))
        return { rows: [{ fully_synced: false, pending_full: false, archived_full: true }] }
      if (statement.sql.includes('public.ack_plugin_state_sync_progress('))
        acks.push(statement)
      return { rows: [] }
    })
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async c => c.json(await drainPluginStateSync(c)))
    const response = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
    expect(await response.json()).toEqual({ claims: 1, apps: 1, failed: 0 })
    expect(argument(acks[0], 'p_app_published')).toEqual([])
    expect(storage.publishedValue(key)).toMatchObject({ built_at: 2 })
  })

  it('publishes a device removal and current app tombstone while a full scan remains archived', async () => {
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
      if (statement.sql.includes('public.ack_plugin_state_sync_progress('))
        acks.push(statement)
      return { rows: [] }
    })
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async c => c.json(await drainPluginStateSync(c)))
    const response = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
    expect(await response.json()).toEqual({ claims: 1, apps: 1, failed: 0 })
    expect(storage.publishedValue(await pluginStateDeviceKey(appId, 'fixture-device'))).toEqual({ channel_id: null })
    expect(storage.publishedValue(await pluginStateAppKey(appId))).toMatchObject({ exists: false, app_id: appId })
    expect(argument(acks[0], 'p_continuations')).toBe('{}')
    expect(argument(acks[0], 'p_full_done')).toEqual([])
  })

  it.each(['deleted', 'channels'] as const)('refreshes an archived app after %s changes without restarting its full scan', async (change) => {
    const appId = `com.test.archived-app-${change}`
    const storage = publicationProviders()
    const key = await pluginStateAppKey(appId)
    const previous = {
      f: 1, app_id: appId, built_at: 1, exists: true,
      owner: { owner_org: '00000000-0000-4000-8000-000000000001' },
      plan: { has_credits: false, customer_id: null, stripe: null },
      channels: [], overrides: {}, manifest_ids: [],
    } satisfies PluginStateAppDoc
    await createPluginStateSyncStore(storage.namespace, storage.pointers, '1').putJson(key, previous)
    const channels: PluginStateChannelRow[] = Array.from({ length: 73 }, (_, index) => ({
      channels: { id: index + 1, name: `channel-${index}` },
      version: { id: index + 100 }, rolloutVersion: { id: null },
      version_ref: index + 100, owner_org: '00000000-0000-4000-8000-000000000002',
    }))
    if (change === 'channels') {
      provider.owner.mockResolvedValue({ owner_org: '00000000-0000-4000-8000-000000000002' })
      provider.channels.mockResolvedValue(channels)
      provider.channelListIds.mockResolvedValue(channels.map(row => row.channels.id))
    }
    const acks: Statement[] = []
    const statements: string[] = []
    const dialect = new PgDialect()
    provider.execute.mockImplementation(async (query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      statements.push(statement.sql)
      if (statement.sql.includes('public.claim_plugin_state_sync('))
        return { rows: [{ result: { status: 'ok', lease_token: 'app-lease', generation: '2', has_more: false,
          apps: [{ app_id: appId, jobs: [{ kind: 'app', ref: '' }], attempts: 1 }],
        } }] }
      if (statement.sql.includes('FROM public.plugin_state_sync_apps'))
        return { rows: [{ fully_synced: false, pending_full: false, archived_full: true }] }
      if (statement.sql.includes('FROM public.orgs o'))
        return { rows: [{ customer_id: null, has_credits: true }] }
      if (statement.sql.includes('public.ack_plugin_state_sync_progress('))
        acks.push(statement)
      return { rows: [] }
    })
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async c => c.json(await drainPluginStateSync(c)))
    const response = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: storage.namespace, PLUGIN_STATE_POINTERS: storage.pointers })
    expect(await response.json()).toEqual({ claims: 1, apps: 1, failed: 0 })
    expect(storage.publishedValue(key)).toMatchObject(change === 'deleted'
      ? { app_id: appId, exists: false }
      : { app_id: appId, exists: true, owner: { owner_org: '00000000-0000-4000-8000-000000000002' }, plan: { has_credits: true }, channels, manifest_ids: [] })
    expect(argument(acks[0], 'p_done')).toEqual([appId])
    expect(argument(acks[0], 'p_continuations')).toBe('{}')
    expect(argument(acks[0], 'p_full_done')).toEqual([])
    expect(argument(acks[0], 'p_app_published')).toEqual([appId])
    expect(statements.some(statement => statement.includes('version_files') || statement.includes('public.manifest'))).toBe(false)
    expect(storage.pointers.list).not.toHaveBeenCalled()
  })

})
