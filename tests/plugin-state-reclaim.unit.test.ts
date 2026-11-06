import type { SQL } from 'drizzle-orm'
import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { PgDialect } from 'drizzle-orm/pg-core'
import { Hono } from 'hono/tiny'
import { describe, expect, it, vi } from 'vitest'
import { pluginStateVersionKey } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'
import { drainPluginStateSync } from '../supabase/functions/_backend/triggers/plugin_state_sync.ts'

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
  it('defers a later same-app claim and writes its fresh value in a new drain', async () => {
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

    const values = new Map<string, unknown>()
    const put = vi.fn(async (key: string, value: string) => {
      values.set(key, JSON.parse(value))
    })
    const binding = { put }
    const app = new Hono<MiddlewareKeyVariables>()
    app.post('/', async (c) => {
      c.set('requestId', 'plugin-state-reclaim-test')
      return c.json(await drainPluginStateSync(c))
    })

    const first = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: binding })
    expect(await first.json()).toEqual({ claims: 2, apps: 1, failed: 0 })
    expect(versionReads).toBe(1)
    expect(put).toHaveBeenCalledTimes(1)
    expect(values.get(await pluginStateVersionKey(appId, bundleName))).toMatchObject({ id: 101 })
    expect(argument(acks[0], 'p_done')).toEqual([appId])
    expect(argument(acks[0], 'p_deferred')).toEqual([])
    expect(argument(acks[1], 'p_done')).toEqual([])
    expect(argument(acks[1], 'p_failed')).toEqual([])
    expect(argument(acks[1], 'p_deferred')).toEqual([appId])

    const second = await app.request('/', { method: 'POST' }, { PLUGIN_STATE: binding })
    expect(await second.json()).toEqual({ claims: 1, apps: 1, failed: 0 })
    expect(versionReads).toBe(2)
    expect(put).toHaveBeenCalledTimes(2)
    expect(values.get(await pluginStateVersionKey(appId, bundleName))).toMatchObject({ id: 202 })
    expect(argument(acks[2], 'p_done')).toEqual([appId])
    expect(argument(acks[2], 'p_deferred')).toEqual([])
    expect(provider.close).toHaveBeenCalledTimes(2)
  })
})
