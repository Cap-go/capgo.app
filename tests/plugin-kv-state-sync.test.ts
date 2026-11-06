import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { getManifestDownloadSize } from '../supabase/functions/_backend/plugin_runtime/utils/manifest_size.ts'
import { pluginStateAppKey, pluginStateManifestKey } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'
import { getPostgresClient, POSTGRES_URL, resetAndSeedAppData, resetAppData } from './test-utils.ts'

const APP_ID = `com.test.pluginstatesync.${randomUUID().slice(0, 8)}`
let client: PoolClient

async function inTransaction(run: () => Promise<void>) {
  await client.query('BEGIN')
  try {
    await client.query('DELETE FROM public.plugin_state_sync_pending WHERE app_id = $1', [APP_ID])
    await client.query('DELETE FROM public.plugin_state_sync_apps WHERE app_id = $1', [APP_ID])
    await client.query('DELETE FROM public.plugin_state_sync_failed WHERE app_id = $1', [APP_ID])
    await client.query('DELETE FROM public.plugin_state_sync_cooldowns WHERE app_id = $1', [APP_ID])
    await run()
  }
  finally {
    await client.query('ROLLBACK')
  }
}

async function enqueue(count = 1, attempts = 0) {
  // Old due times make these dedicated rows the first candidate without
  // changing any other test's queue rows.
  await client.query(`
    INSERT INTO public.plugin_state_sync_pending (app_id, kind, ref, due_at, attempts)
    SELECT $1, 'device', 'sync-test-' || n, now() - interval '10 years', $3
    FROM generate_series(1, $2::integer) n`, [APP_ID, count, attempts])
}

interface Claim {
  status: 'ok' | 'empty' | 'busy'
  lease_token?: string
  apps?: { app_id: string, jobs: { kind: string, ref: string }[], attempts: number }[]
}

async function claim() {
  const { rows } = await client.query<{ result: Claim }>('SELECT public.claim_plugin_state_sync(200) AS result')
  return rows[0].result
}

async function ack(token: string) {
  await client.query(`SELECT public.ack_plugin_state_sync(
    p_lease_token => $1::uuid, p_done => ARRAY[$2]::text[])`, [token, APP_ID])
}

describe('plugin KV sync queue contracts', () => {
  beforeAll(async () => {
    await resetAndSeedAppData(APP_ID)
    client = await (await getPostgresClient()).connect()
  })

  afterAll(async () => {
    client?.release()
    await resetAppData(APP_ID)
  })

  afterEach(() => vi.unstubAllEnvs())

  it('returns replica sizes for a database-only manifest with authoritative apps enabled', async () => {
    // Hono's Node adapter reads process.env rather than Worker bindings.
    vi.stubEnv('ENV_NAME', 'capgo_plugin-local')
    vi.stubEnv('LOCAL_READ_REPLICA_SUPABASE_DB_URL', POSTGRES_URL)
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.stubEnv('PLUGIN_STATE_KV_AUTHORITATIVE', 'true')
    vi.stubEnv('PLUGIN_STATE_KV_STRICT', 'true')
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    const { rows: versions } = await client.query<{ id: string, name: string }>(`
      INSERT INTO public.app_versions (app_id, name, owner_org, storage_provider)
      SELECT app_id, '9.1.0', owner_org, 'r2' FROM public.apps WHERE app_id = $1
      RETURNING id, name`, [APP_ID])
    const version = { id: Number(versions[0].id), name: versions[0].name }
    const fileHash = 'e'.repeat(64)
    await client.query(`INSERT INTO public.manifest (app_version_id, file_name, file_hash, s3_path, file_size)
      VALUES ($1, 'historical.js', $2, 'plugin-state-sync/historical.js', 256)`, [version.id, fileHash])
    const appKey = await pluginStateAppKey(APP_ID)
    const reads: string[] = []
    const app = new Hono<{ Variables: { requireReadReplica: boolean } }>()
    app.get('/', async (c) => {
      c.set('requireReadReplica', true)
      return c.json(await getManifestDownloadSize(c, APP_ID, version.name, version.id, [
        { file_name: 'historical.js', file_hash: fileHash, download_url: `https://example.com/files/read?key=${version.id}` },
      ], 'manifest-fallback-device'))
    })
    const response = await app.request('/', undefined, {
      ENV_NAME: 'capgo_plugin-local',
      LOCAL_READ_REPLICA_SUPABASE_DB_URL: POSTGRES_URL,
      PLUGIN_STATE_KV: 'on',
      PLUGIN_STATE_KV_AUTHORITATIVE: 'true',
      PLUGIN_STATE_KV_STRICT: 'true',
      PLUGIN_STATE: {
        get: (key: string) => {
          reads.push(key)
          return key === appKey
            ? { f: 1, app_id: APP_ID, built_at: Date.now(), exists: true, owner: { owner_org: '00000000-0000-4000-8000-000000000001' }, plan: { has_credits: false, customer_id: null, stripe: null }, channels: [], overrides: {}, manifest_ids: [] }
            : null
        },
      },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('X-Plugin-State')).toBe('fallback')
    expect(response.headers.get('X-Database-Source')).toBe('local_read_replica')
    expect(reads).toContain(pluginStateManifestKey(version.id))
    expect(await response.json()).toMatchObject({ totalSize: 256, knownFiles: 1, unknownFiles: 0 })
  })

  it('bounds each app claim and retains remaining work', async () => {
    await inTransaction(async () => {
      await enqueue(160)
      const result = await claim()
      expect(result.apps?.find(app => app.app_id === APP_ID)?.jobs).toHaveLength(128)
      expect(result.lease_token).toBeTypeOf('string')
      await ack(result.lease_token!)
      const { rows } = await client.query<{ count: string }>('SELECT count(*) FROM public.plugin_state_sync_pending WHERE app_id = $1', [APP_ID])
      expect(Number(rows[0].count)).toBe(32)
    })
  })

  it('keeps same-app writes at least one second apart across invocations', async () => {
    await inTransaction(async () => {
      await enqueue()
      const first = await claim()
      await ack(first.lease_token!)
      await enqueue()
      const second = await claim()
      expect(second.apps?.some(app => app.app_id === APP_ID) ?? false).toBe(false)
      await client.query(`UPDATE public.plugin_state_sync_cooldowns SET next_write_at = now() - interval '2 seconds' WHERE app_id = $1`, [APP_ID])
      const third = await claim()
      expect(third.apps?.find(app => app.app_id === APP_ID)?.jobs).toHaveLength(1)
    })
  })

  it('archives the exact keys after five failures and never grants a sixth lease', async () => {
    await inTransaction(async () => {
      await enqueue(1, 4)
      const fifth = await claim()
      expect(fifth.apps?.find(app => app.app_id === APP_ID)?.attempts).toBe(5)
      await client.query(`SELECT public.ack_plugin_state_sync(
        p_lease_token => $1::uuid, p_done => '{}'::text[], p_failed => ARRAY[$2]::text[])`, [fifth.lease_token, APP_ID])
      const { rows } = await client.query<{ kind: string, ref: string }>('SELECT kind, ref FROM public.plugin_state_sync_failed WHERE app_id = $1', [APP_ID])
      expect(rows).toEqual([{ kind: 'device', ref: 'sync-test-1' }])
      await enqueue(1, 5)
      const sixth = await claim()
      expect(sixth.apps?.some(app => app.app_id === APP_ID) ?? false).toBe(false)
    })
  })

  it('releases capacity-deferred work without spending its failure budget', async () => {
    await inTransaction(async () => {
      await enqueue()
      const first = await claim()
      await client.query(`SELECT public.ack_plugin_state_sync(
        p_lease_token => $1::uuid, p_done => '{}'::text[], p_deferred => ARRAY[$2]::text[])`, [first.lease_token, APP_ID])
      const { rows } = await client.query<{ attempts: number, lease_token: string | null }>('SELECT attempts, lease_token FROM public.plugin_state_sync_pending WHERE app_id = $1', [APP_ID])
      expect(rows).toEqual([{ attempts: 0, lease_token: null }])
    })
  })

  it('does not expose internal queue RPCs to anonymous or authenticated clients', async () => {
    const { rows } = await client.query<{ allowed: boolean }>(`
      SELECT has_function_privilege(role_name, function_name, 'EXECUTE') AS allowed
      FROM unnest(ARRAY['anon', 'authenticated']) AS role_name
      CROSS JOIN unnest(ARRAY[
        'public.claim_plugin_state_sync(integer)',
        'public.enqueue_plugin_state_full_sync(text[])',
        'public.plugin_state_sync_tick()'
      ]) AS function_name`)
    expect(rows.every(row => !row.allowed)).toBe(true)
  })
})
