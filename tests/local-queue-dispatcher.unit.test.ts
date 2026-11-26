import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseJsonc } from '../scripts/generate-plugin-route-hosts.ts'
import { hostDbUrl, LOCAL_API_WORKER, pointDbUrlAtHost, scheduledTriggerUrl } from '../scripts/local-queue-dispatcher.ts'

const API_CONFIG = fileURLToPath(new URL('../cloudflare_workers/api/wrangler.jsonc', import.meta.url))

interface LocalApiConfig {
  env: { local: {
    name: string
    durable_objects: { bindings: { name: string, class_name: string }[] }
    services?: { binding: string, service: string }[]
  } }
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

  it('points db_url at the host Supabase URL', async () => {
    const queries: { sql: string, params?: unknown[] }[] = []
    const client = { query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params })
      return { rows: [] }
    } } as never
    await pointDbUrlAtHost(client, 'http://127.0.0.1:54321')
    expect(queries).toHaveLength(1)
    expect(queries[0].sql).toContain('INSERT INTO private.settings')
    expect(queries[0].params).toEqual(['http://127.0.0.1:54321'])
  })
})
