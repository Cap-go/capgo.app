import type { PoolClient } from 'pg'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { getManifestDownloadSize } from '../supabase/functions/_backend/plugin_runtime/utils/manifest_size.ts'
import { pluginStateAppKey, pluginStateImmutableKey, pluginStateManifestKey } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'
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
  generation?: string
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
    const publishedAppKey = await pluginStateImmutableKey(appKey, '1')
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
      PLUGIN_STATE_POINTERS: {
        get: async (key: string) => {
          reads.push(key)
          return key === appKey ? { json: async () => ({ f: 1, generation: '1', kvKey: publishedAppKey }) } : null
        },
      },
      PLUGIN_STATE: {
        get: (key: string) => {
          return key === publishedAppKey
            ? { f: 1, app_id: APP_ID, built_at: Date.now(), exists: true, owner: { owner_org: '00000000-0000-4000-8000-000000000001', block_provider_infra_requests: false }, plan: { has_credits: false, customer_id: null, stripe: null }, channels: [], overrides: {}, manifest_ids: [] }
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

  it('deduplicates 5k app and manifest notifications within one producer transaction', async () => {
    await inTransaction(async () => {
      await client.query(`SELECT set_config('capgo.plugin_state_wake_sent', 'on', true)`)
      await client.query(`
        SELECT public.notify_plugin_state_sync('app', ARRAY[$1]::text[]),
          public.notify_plugin_state_sync('manifest', ARRAY[$1]::text[], ARRAY['12345']::text[])
        FROM generate_series(1, 5000)`, [APP_ID])
      const { rows } = await client.query<{ kind: string, count: string }>(`
        SELECT kind, count(*)::text AS count FROM public.plugin_state_sync_pending
        WHERE app_id = $1 GROUP BY kind ORDER BY kind`, [APP_ID])
      expect(rows).toEqual([{ kind: 'app', count: '1' }, { kind: 'manifest', count: '1' }])
    })
  })

  it('deduplicates long identifiers without exceeding the B-tree key limit', async () => {
    await inTransaction(async () => {
      const longRef = 'manifest-cursor-'.repeat(1000)
      await client.query(`SELECT set_config('capgo.plugin_state_wake_sent', 'on', true)`)
      await client.query(`SELECT public.notify_plugin_state_sync('full', ARRAY[$1, $1]::text[], ARRAY[$2, $2]::text[])`, [APP_ID, longRef])
      const { rows } = await client.query<{ ref: string, key_bytes: number }>(`
        SELECT ref, octet_length(producer_job_key) AS key_bytes
        FROM public.plugin_state_sync_pending WHERE app_id = $1`, [APP_ID])
      expect(rows).toEqual([{ ref: longRef, key_bytes: 32 }])
    })
  })

  it('does not wait for a different uncommitted producer transaction', async () => {
    const producer = new Client({ connectionString: POSTGRES_URL })
    await producer.connect()
    try {
      await inTransaction(async () => {
        await client.query(`SELECT set_config('capgo.plugin_state_wake_sent', 'on', true)`)
        await client.query(`SELECT public.notify_plugin_state_sync('app', ARRAY[$1]::text[])`, [APP_ID])
        await producer.query('BEGIN')
        await producer.query('SET LOCAL statement_timeout = 2000')
        await producer.query(`SELECT set_config('capgo.plugin_state_wake_sent', 'on', true)`)
        await producer.query(`SELECT public.notify_plugin_state_sync('app', ARRAY[$1]::text[])`, [APP_ID])
        const { rows } = await producer.query<{ count: string }>(`
          SELECT count(*)::text AS count FROM public.plugin_state_sync_pending
          WHERE app_id = $1 AND producer_xid = pg_catalog.pg_current_xact_id()`, [APP_ID])
        // The first producer is not committed or visible to this connection.
        expect(rows).toEqual([{ count: '1' }])
      })
    }
    finally {
      await producer.query('ROLLBACK')
      await producer.end()
    }
  })

  it('retains a separate producer transaction while an earlier same-key job is leased', async () => {
    // The test-utils pool is intentionally limited to one connection, held by
    // this file. Use a distinct direct client for the second producer.
    const producer = new Client({ connectionString: POSTGRES_URL })
    await producer.connect()
    const leaseToken = randomUUID()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM public.plugin_state_sync_pending WHERE app_id = $1', [APP_ID])
      await client.query('DELETE FROM public.plugin_state_sync_cooldowns WHERE app_id = $1', [APP_ID])
      await client.query(`SELECT set_config('capgo.plugin_state_wake_sent', 'on', true)`)
      await client.query(`SELECT public.notify_plugin_state_sync('app', ARRAY[$1]::text[])`, [APP_ID])
      // Lease this fixture before committing it. A global claimer must never
      // be able to consume the row between our COMMIT and the second producer.
      const leased = await client.query(`UPDATE public.plugin_state_sync_pending
        SET lease_token = $2::uuid, leased_until = clock_timestamp() + interval '2 minutes', attempts = 1
        WHERE app_id = $1 RETURNING id`, [APP_ID, leaseToken])
      expect(leased.rows).toHaveLength(1)
      await client.query('COMMIT')

      await producer.query('BEGIN')
      await producer.query(`SET LOCAL statement_timeout = 2000`)
      await producer.query(`SELECT set_config('capgo.plugin_state_wake_sent', 'on', true)`)
      await producer.query(`SELECT public.notify_plugin_state_sync('app', ARRAY[$1]::text[])`, [APP_ID])
      await producer.query('COMMIT')
      const { rows: pending } = await client.query<{ producer_xid: string, lease_token: string | null }>(`
        SELECT producer_xid::text, lease_token FROM public.plugin_state_sync_pending WHERE app_id = $1 ORDER BY id`, [APP_ID])
      expect(pending).toHaveLength(2)
      expect(pending[0].producer_xid).not.toBe(pending[1].producer_xid)
      expect(pending[0].lease_token).toBe(leaseToken)
      expect(pending[1].lease_token).toBeNull()
      await ack(leaseToken)
      const { rows: retained } = await client.query<{ producer_xid: string }>(`
        SELECT producer_xid::text FROM public.plugin_state_sync_pending WHERE app_id = $1`, [APP_ID])
      expect(retained).toEqual([{ producer_xid: pending[1].producer_xid }])
    }
    finally {
      await producer.query('ROLLBACK')
      await producer.end()
      await client.query('ROLLBACK')
      await client.query('DELETE FROM public.plugin_state_sync_pending WHERE app_id = $1', [APP_ID])
      await client.query('DELETE FROM public.plugin_state_sync_apps WHERE app_id = $1', [APP_ID])
      await client.query('DELETE FROM public.plugin_state_sync_cooldowns WHERE app_id = $1', [APP_ID])
    }
  })

  it('bounds each app claim and retains remaining work', async () => {
    await inTransaction(async () => {
      await enqueue(160)
      const result = await claim()
      expect(result.apps?.find(app => app.app_id === APP_ID)?.jobs).toHaveLength(48)
      expect(result.lease_token).toBeTypeOf('string')
      await ack(result.lease_token!)
      const { rows } = await client.query<{ count: string }>('SELECT count(*) FROM public.plugin_state_sync_pending WHERE app_id = $1', [APP_ID])
      expect(Number(rows[0].count)).toBe(112)
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

  it('allocates increasing generations and ignores a replaced drain acknowledgement', async () => {
    await inTransaction(async () => {
      await enqueue()
      const first = await claim()
      await client.query(`UPDATE public.plugin_state_sync_pending SET leased_until = now() - interval '1 second' WHERE app_id = $1`, [APP_ID])
      const replacement = await claim()
      expect(BigInt(replacement.generation!)).toBeGreaterThan(BigInt(first.generation!))
      await ack(first.lease_token!)
      const { rows: pending } = await client.query<{ lease_token: string }>('SELECT lease_token FROM public.plugin_state_sync_pending WHERE app_id = $1', [APP_ID])
      expect(pending).toEqual([{ lease_token: replacement.lease_token }])
      const { rows: bookkeeping } = await client.query('SELECT app_id FROM public.plugin_state_sync_apps WHERE app_id = $1', [APP_ID])
      expect(bookkeeping).toEqual([])
    })
  })

  it('retains pending changes when the HTTP wake raises', async () => {
    await inTransaction(async () => {
      await client.query(`CREATE OR REPLACE FUNCTION public.wake_plugin_state_sync()
        RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $body$
        BEGIN RAISE EXCEPTION 'synthetic plugin wake failure'; END;
        $body$`)
      await client.query(`SELECT set_config('capgo.plugin_state_wake_sent', '', true)`)
      await client.query(`SELECT public.notify_plugin_state_sync('device', ARRAY[$1]::text[], ARRAY['wake-failure-device']::text[])`, [APP_ID])
      const { rows } = await client.query<{ ref: string }>('SELECT ref FROM public.plugin_state_sync_pending WHERE app_id = $1', [APP_ID])
      expect(rows).toEqual([{ ref: 'wake-failure-device' }])
    })
  })

  it('persists both purge scopes atomically with successful sync acknowledgement', async () => {
    await inTransaction(async () => {
      await enqueue()
      const first = await claim()
      await client.query('DELETE FROM public.updates_cache_purge_pending WHERE app_id = $1', [APP_ID])
      await client.query(`SELECT public.ack_plugin_state_sync(
        p_lease_token => $1::uuid, p_done => ARRAY[$2]::text[], p_versions_changed => ARRAY[$2]::text[])`, [first.lease_token, APP_ID])
      const { rows: purges } = await client.query<{ scope: string }>('SELECT scope FROM public.updates_cache_purge_pending WHERE app_id = $1 ORDER BY scope', [APP_ID])
      expect(purges).toEqual([{ scope: 'app' }, { scope: 'versions' }])
      const { rows: pending } = await client.query('SELECT id FROM public.plugin_state_sync_pending WHERE app_id = $1', [APP_ID])
      expect(pending).toEqual([])
    })
  })

  it('keeps sync work when durable purge insertion fails', async () => {
    await inTransaction(async () => {
      await enqueue()
      const first = await claim()
      await client.query(`CREATE FUNCTION pg_temp.fail_plugin_sync_purge()
        RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $body$
        BEGIN RAISE EXCEPTION 'synthetic durable purge failure'; END;
        $body$`)
      await client.query(`CREATE TRIGGER test_fail_plugin_sync_purge BEFORE INSERT ON public.updates_cache_purge_pending
        FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_plugin_sync_purge()`)
      await client.query('SAVEPOINT before_ack')
      await expect(ack(first.lease_token!)).rejects.toThrow('synthetic durable purge failure')
      await client.query('ROLLBACK TO SAVEPOINT before_ack')
      const { rows } = await client.query('SELECT id FROM public.plugin_state_sync_pending WHERE app_id = $1 AND lease_token = $2', [APP_ID, first.lease_token])
      expect(rows).toHaveLength(1)
    })
  })

  it('does not expose internal queue RPCs to anonymous or authenticated clients', async () => {
    const { rows } = await client.query<{ allowed: boolean }>(`
      SELECT has_function_privilege(role_name, function_name, 'EXECUTE') AS allowed
      FROM unnest(ARRAY['anon', 'authenticated']) AS role_name
      CROSS JOIN unnest(ARRAY[
        'public.claim_plugin_state_sync(integer)',
        'public.enqueue_plugin_state_full_sync(text[])',
        'public.plugin_state_sync_tick()',
        'public.claim_plugin_state_gc()',
        'public.ack_plugin_state_gc(uuid,text,boolean)'
      ]) AS function_name`)
    expect(rows.every(row => !row.allowed)).toBe(true)
  })
})
