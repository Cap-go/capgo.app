/**
 * Setup of `bun run test:cloudflare:plugin:kv`: the plugin test files run
 * against the KV plugin state instead of the database.
 *
 * The plugin worker runs with PLUGIN_STATE_KV=on, authoritative and strict
 * (a request answered from the state fails if it opens a database
 * connection). Here, the sync switch is turned on, every app gets its first
 * full sync, and every request to a plugin endpoint first drains the sync
 * queue: the KV state then holds what the test wrote, as it would a few
 * seconds after the write in production.
 */
import { Pool } from 'pg'
import { afterAll, beforeAll, expect } from 'vitest'
import { API_SECRET, CLOUDFLARE_API_URL, CLOUDFLARE_PLUGIN_URL, POSTGRES_URL } from './test-utils.ts'

const PLUGIN_PATHS = ['/updates', '/channel_self', '/stats', '/plugin/']
const DRAIN_TIMEOUT_MS = 90_000
/** X-Plugin-State values that mean the KV state did not answer the request alone. */
const FAILED_STATES = new Set(['kv-escaped', 'fallback', 'miss', 'error'])
/** X-Plugin-State of every plugin response of this test file ('none': answered before the state was read). */
const responseStates = new Map<string, number>()

const originalFetch = globalThis.fetch.bind(globalThis)
let draining: Promise<void> | null = null

async function drainOnce() {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS
  const pool = new Pool({ connectionString: POSTGRES_URL, max: 1 })
  try {
    while (Date.now() < deadline) {
      const response = await originalFetch(`${CLOUDFLARE_API_URL}/triggers/plugin_state_sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apisecret': API_SECRET },
        body: JSON.stringify({ drain: true }),
      })
      const body = await response.json().catch(() => null) as { claims?: number, failed?: number } | null
      if (!response.ok)
        throw new Error(`plugin state sync drain failed: ${response.status} ${JSON.stringify(body)}`)
      if (body?.failed)
        throw new Error(`plugin state sync failed for ${body.failed} app(s)`)
      // A claim can be empty during the per-app KV write cooldown. Only an
      // empty pending queue proves that the writer has caught up with fixtures.
      const { rows } = await pool.query<{ pending: boolean }>('SELECT EXISTS (SELECT 1 FROM public.plugin_state_sync_pending) AS pending')
      if (!rows[0].pending)
        return
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  finally {
    await pool.end()
  }
  throw new Error('plugin state sync did not settle')
}

/** Drains the sync queue; concurrent callers share one drain. */
export function drainPluginStateSync() {
  draining ??= drainOnce().finally(() => {
    draining = null
  })
  return draining
}

function isPluginRequest(input: Parameters<typeof fetch>[0]) {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!raw.startsWith(CLOUDFLARE_PLUGIN_URL))
    return false
  const path = new URL(raw).pathname
  return PLUGIN_PATHS.some(prefix => path.startsWith(prefix))
}

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  if (!isPluginRequest(input))
    return originalFetch(input, init)
  await drainPluginStateSync()
  const response = await originalFetch(input, init)
  const state = response.headers.get('X-Plugin-State') ?? 'none'
  responseStates.set(state, (responseStates.get(state) ?? 0) + 1)
  return response
}) as typeof fetch

beforeAll(async () => {
  const pool = new Pool({ connectionString: POSTGRES_URL, max: 1 })
  try {
    await pool.query(`
      SELECT vault.create_secret('true', 'CAPGO_PLUGIN_STATE_SYNC_ENABLED', 'plugin KV state tests')
      WHERE NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'CAPGO_PLUGIN_STATE_SYNC_ENABLED')`)
    await pool.query(`
      SELECT public.enqueue_plugin_state_full_sync(ARRAY(
        SELECT a.app_id::text FROM public.apps a
        WHERE NOT EXISTS (
          SELECT 1 FROM public.plugin_state_sync_apps s
          WHERE s.app_id = a.app_id AND s.full_synced_at IS NOT NULL
        )
      ))`)
  }
  finally {
    await pool.end()
  }
  await drainPluginStateSync()
}, 120_000)

afterAll(() => {
  const summary = Object.fromEntries(responseStates)
  console.info('[plugin-kv-state] plugin responses by X-Plugin-State', summary)
  // Every request the state was asked to answer was answered by it alone.
  expect([...responseStates.keys()].filter(state => FAILED_STATES.has(state))).toEqual([])
})
