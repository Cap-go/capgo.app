import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseJsonc } from '../scripts/generate-plugin-route-hosts.ts'
import { hostDbUrl, LOCAL_API_WORKER, restorePgNet, routeToOutbox, scheduledTriggerUrl, SEED_DB_URL } from '../scripts/local-queue-dispatcher.ts'

const API_CONFIG = fileURLToPath(new URL('../cloudflare_workers/api/wrangler.jsonc', import.meta.url))

interface LocalApiConfig {
  env: { local: {
    name: string
    durable_objects: { bindings: { name: string, class_name: string }[] }
    services?: { binding: string, service: string }[]
  } }
}

function recordingClient() {
  const queries: { sql: string, params?: unknown[] }[] = []
  return {
    queries,
    client: { query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params })
      return { rows: [] }
    } } as never,
  }
}

describe('local queue dispatcher', () => {
  it('binds the dispatcher and its self service in the local API worker env', () => {
    const { env } = parseJsonc(readFileSync(API_CONFIG, 'utf8')) as LocalApiConfig
    expect(env.local.name).toBe(LOCAL_API_WORKER)
    expect(env.local.durable_objects.bindings).toContainEqual({ name: 'QUEUE_DISPATCHER', class_name: 'QueueDispatcher' })
    expect(env.local.services).toContainEqual({ binding: 'API_SELF', service: LOCAL_API_WORKER })
  })

  it('uses the host Supabase origin as db_url, so the dispatcher allows it as SUPABASE_URL', () => {
    expect(hostDbUrl('http://127.0.0.1:60321/')).toBe('http://127.0.0.1:60321')
    expect(hostDbUrl('http://127.0.0.1:54321')).toBe('http://127.0.0.1:54321')
  })

  it('fires the cron on the API worker by name, not on the router', () => {
    expect(scheduledTriggerUrl(8787)).toBe(`http://127.0.0.1:8787/cdn-cgi/local/explorer/api/local/scheduled?worker=${LOCAL_API_WORKER}`)
  })

  it('routes every target to the outbox with the host db_url', async () => {
    const { client, queries } = recordingClient()
    await routeToOutbox(client, 'http://127.0.0.1:54321')
    expect(queries).toHaveLength(2)
    expect(queries[0].sql).toContain('private.settings')
    expect(queries[0].params).toEqual(['http://127.0.0.1:54321'])
    expect(queries[1].sql).toContain(`INSERT INTO public.http_dispatch_targets (target) VALUES ('*')`)
  })

  it('restores the seed db_url only when it is still ours, and drops the * route', async () => {
    const { client, queries } = recordingClient()
    await restorePgNet(client, 'http://127.0.0.1:54321')
    expect(queries[0].sql).toContain(`DELETE FROM public.http_dispatch_targets WHERE target = '*'`)
    expect(queries[1].sql).toContain(`AND value = $2`)
    expect(queries[1].params).toEqual([SEED_DB_URL, 'http://127.0.0.1:54321'])
  })
})
