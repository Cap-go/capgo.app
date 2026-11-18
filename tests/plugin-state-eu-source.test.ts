import type { PoolClient } from 'pg'
import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono/tiny'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPluginStateSourceReader } from '../supabase/functions/_backend/triggers/plugin_state_sync.ts'
import { getPostgresClient, POSTGRES_URL } from './test-utils.ts'

const appId = `com.example.eu-source.${randomUUID()}`
const replicaName = `plugin_source_${randomUUID().replaceAll('-', '')}`
const replicaUrl = new URL(POSTGRES_URL)
replicaUrl.pathname = replicaName
let control: PoolClient
let replica: Client

async function rollback(run: () => Promise<void>) {
  await control.query('BEGIN')
  try {
    await control.query("SELECT set_config('capgo.plugin_state_wake_sent', 'on', true)")
    await run()
  }
  finally {
    await control.query('ROLLBACK')
  }
}

async function enable() {
  await control.query(`CREATE OR REPLACE FUNCTION public.plugin_state_sync_enabled()
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT true $$`)
}

async function claim() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await control.query('SELECT public.claim_plugin_state_sync(1) AS claim')
    if (result.rows[0].claim.status !== 'busy')
      return result.rows[0].claim
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Plugin state claim stayed busy')
}

describe('EU source commit barrier and primary progress', () => {
  beforeAll(async () => {
    control = await (await getPostgresClient()).connect()
    await control.query(`CREATE DATABASE ${replicaName}`)
    replica = new Client({ connectionString: replicaUrl.href })
    await replica.connect()
    vi.stubEnv('ENV_NAME', 'capgo_api-local')
    vi.stubEnv('LOCAL_READ_REPLICA_SUPABASE_DB_URL', replicaUrl.href)
    // A separate local database models an independently applied EU snapshot.
    // It deliberately contains no primary queue/control tables or functions.
    await replica.query(`CREATE TABLE public.read_replica_commit_marker(id smallint PRIMARY KEY, committed_at timestamptz NOT NULL);
      CREATE TABLE public.app_versions(id bigint PRIMARY KEY, deleted boolean);
      CREATE TABLE public.delta_files(id bigint PRIMARY KEY, file_size bigint);
      INSERT INTO public.read_replica_commit_marker VALUES(1, '2026-01-01');
      INSERT INTO public.app_versions VALUES(1, false);
      INSERT INTO public.delta_files VALUES(1, 128);`)
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    await replica?.end()
    if (control) {
      await control.query(`DROP DATABASE IF EXISTS ${replicaName} WITH (FORCE)`)
      control.release()
    }
  })

  it('gates all source data on the replicated marker and freezes related reads in the same EU snapshot', async () => {
    const barrier = '2026-11-18 12:00:00.123456+00'
    const load = async () => {
      const app = new Hono<MiddlewareKeyVariables>()
      app.get('/', async (c) => {
        const source = createPluginStateSourceReader(c, Date.now() + 10_000, barrier)
        const doc = await source.read(async (db) => {
          const version = await db.execute(sql`SELECT deleted FROM public.app_versions WHERE id = 1`)
          // Another connection commits deletion, manifest edits and a newer marker
          // AFTER the reader has acquired its repeatable-read snapshot.
          await replica.query(`BEGIN; UPDATE public.app_versions SET deleted = true;
            UPDATE public.delta_files SET file_size = 256;
            UPDATE public.read_replica_commit_marker SET committed_at = '2026-11-18 13:00'; COMMIT;`)
          const files = await db.execute(sql`SELECT file_size::text AS size FROM public.delta_files WHERE id = 1`)
          return { deleted: version.rows[0].deleted, size: files.rows[0].size }
        })
        return c.json(doc)
      })
      return app.request('/', {}, {
        HYPERDRIVE_CAPGO_READ_PLUGIN_STATE_EU: { connectionString: replicaUrl.href },
        // A primary fallback would fail the test instead of accidentally passing.
        HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgresql://invalid-primary:1/postgres' },
      })
    }
    expect((await load()).status).toBe(500)
    expect((await replica.query('SELECT deleted FROM public.app_versions')).rows[0].deleted).toBe(false)
    await replica.query('UPDATE public.read_replica_commit_marker SET committed_at = $1', [barrier])
    vi.stubEnv('ENV_NAME', 'capgo_api-prod')
    // A fresh marker is insufficient if its source tables are not streaming.
    expect((await load()).status).toBe(500)
    vi.stubEnv('ENV_NAME', 'capgo_api-local')
    const response = await load()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ deleted: false, size: '128' })
  })

  it('reserves strictly increasing source commit barriers even when the stored marker is ahead of the wall clock', async () => rollback(async () => {
    await control.query("UPDATE public.read_replica_commit_marker SET committed_at = '2100-01-01' WHERE id = 1")
    const first = (await control.query('SELECT public.reserve_plugin_state_source_barrier()::text AS barrier')).rows[0].barrier
    await control.query('SELECT public.touch_read_replica_commit_marker()')
    const result = (await control.query(`SELECT committed_at > $1::timestamptz AS increased,
      committed_at > clock_timestamp() AS clock_rollback FROM public.read_replica_commit_marker WHERE id = 1`, [first])).rows[0]
    expect(result).toEqual({ increased: true, clock_rollback: true })
  }))

  it('reserves one marker write for a 48-job payload batch', async () => rollback(async () => {
    await enable()
    await control.query("UPDATE public.read_replica_commit_marker SET committed_at = '2100-01-01' WHERE id = 1")
    await control.query(`INSERT INTO public.plugin_state_sync_pending(app_id, kind, ref, due_at)
      SELECT $1, 'manifest', n::text, '-infinity' FROM generate_series(1,48) n`, [appId])
    const leased = await claim()
    expect(leased.apps[0].jobs).toHaveLength(48)
    expect((await control.query(`SELECT committed_at = '2100-01-01'::timestamptz + interval '1 microsecond' AS once
      FROM public.read_replica_commit_marker WHERE id = 1`)).rows[0].once).toBe(true)
  }))

  it('retains the exact barrier and full cursor through repeated lag deferrals without exhausting five attempts', async () => rollback(async () => {
    await enable()
    await control.query('DELETE FROM public.plugin_state_sync_pending WHERE app_id = $1', [appId])
    const ref = JSON.stringify({ p: 'versions', after: 'v-0047' })
    await control.query("INSERT INTO public.plugin_state_sync_pending(app_id, kind, ref, due_at) VALUES($1, 'full', $2, '-infinity')", [appId, ref])
    let barrier: string | undefined
    for (let pass = 0; pass < 7; pass++) {
      await control.query("UPDATE public.plugin_state_sync_pending SET due_at = '-infinity' WHERE app_id = $1", [appId])
      await control.query('DELETE FROM public.plugin_state_sync_cooldowns WHERE app_id = $1', [appId])
      const leased = await claim()
      const item = leased.apps.find((item: { app_id: string }) => item.app_id === appId)
      barrier ??= item.required_commit_at
      expect(item.required_commit_at).toBe(barrier)
      expect(item.attempts).toBe(1)
      await control.query(`SELECT public.ack_plugin_state_sync_progress(p_lease_token => $1,
        p_done => '{}', p_deferred => $2, p_changed_apps => '{}')`, [leased.lease_token, [appId]])
      const pending = (await control.query('SELECT attempts, ref, source_commit_at::text AS barrier FROM public.plugin_state_sync_pending WHERE app_id = $1', [appId])).rows
      expect(pending).toEqual([{ attempts: 0, ref, barrier }])
    }
  }))

  it('carries the proven barrier into full continuation ACKs and leaves newer producer jobs independent', async () => rollback(async () => {
    await enable()
    await control.query('DELETE FROM public.plugin_state_sync_pending WHERE app_id = $1', [appId])
    await control.query("INSERT INTO public.plugin_state_sync_pending(app_id, kind, ref, due_at) VALUES($1, 'full', '', '-infinity')", [appId])
    const leased = await claim()
    const barrier = leased.apps[0].required_commit_at
    await control.query("INSERT INTO public.plugin_state_sync_pending(app_id, kind, ref) VALUES($1, 'version', 'new-version')", [appId])
    const cursor = '{"p":"versions","after":"v-0047"}'
    await control.query(`SELECT public.ack_plugin_state_sync_progress(p_lease_token => $1, p_done => $2,
      p_continuations => $3, p_changed_apps => '{}')`, [leased.lease_token, [appId], JSON.stringify({ [appId]: cursor })])
    const jobs = (await control.query('SELECT kind, ref, source_commit_at::text AS barrier FROM public.plugin_state_sync_pending WHERE app_id = $1 ORDER BY kind', [appId])).rows
    expect(jobs).toEqual([{ kind: 'full', ref: cursor, barrier }, { kind: 'version', ref: 'new-version', barrier: null }])
  }))

  it('preserves policy work and its barrier during replica outage without granting publication retries', async () => rollback(async () => {
    await control.query('DELETE FROM public.serving_policy_sync_pending WHERE app_id = $1', [appId])
    await control.query("INSERT INTO public.serving_policy_sync_pending(app_id, due_at) VALUES($1, '-infinity')", [appId])
    let barrier: string | undefined
    for (let pass = 0; pass < 7; pass++) {
      await control.query("UPDATE public.serving_policy_sync_pending SET due_at = '-infinity' WHERE app_id = $1", [appId])
      const leased = (await control.query('SELECT * FROM public.claim_serving_policy_sync_source()')).rows[0]
      barrier ??= leased.required_commit_at
      expect(leased.required_commit_at).toBe(barrier)
      await control.query('SELECT public.defer_serving_policy_sync($1)', [leased.token])
      expect((await control.query('SELECT attempts FROM public.serving_policy_sync_pending WHERE app_id = $1', [appId])).rows).toEqual([{ attempts: 0 }])
    }
  }))

  it('restores archived historical keys only for an explicit asynchronous full repair', async () => rollback(async () => {
    await enable()
    await control.query('DELETE FROM public.plugin_state_sync_pending WHERE app_id = $1', [appId])
    await control.query("INSERT INTO public.plugin_state_sync_failed(app_id, kind, ref, repair_at) VALUES($1, 'manifest', '12345', now())", [appId])
    await control.query("UPDATE public.plugin_state_sync_state SET backfill_after = NULL, backfill_done_at = NULL, source_commit_at = NULL, repair_requested = false WHERE id")
    const page = (await control.query("SELECT public.prepare_plugin_state_inventory('payload') AS page")).rows[0].page
    await control.query("SELECT public.commit_plugin_state_inventory('payload', NULL, $1, NULL, $2)", [page.required_commit_at, [appId]])
    expect((await control.query('SELECT app_id FROM public.plugin_state_sync_failed WHERE app_id = $1', [appId])).rows).toHaveLength(1)
    await control.query('SELECT public.enqueue_plugin_state_full_sync(NULL)')
    const repair = (await control.query("SELECT public.prepare_plugin_state_inventory('payload') AS page")).rows[0].page
    await control.query("SELECT public.commit_plugin_state_inventory('payload', NULL, $1, NULL, $2)", [repair.required_commit_at, [appId]])
    expect((await control.query('SELECT app_id FROM public.plugin_state_sync_failed WHERE app_id = $1', [appId])).rows).toEqual([])
    expect((await control.query('SELECT kind, ref, attempts FROM public.plugin_state_sync_pending WHERE app_id = $1 ORDER BY kind', [appId])).rows)
      .toEqual([{ kind: 'full', ref: '', attempts: 0 }, { kind: 'manifest', ref: '12345', attempts: 0 }])
  }))

  it('coalesces committed repairs before the first claim but preserves requests after a claim or deferral', async () => {
    const repairApp = `${appId}.repair-coalescing`
    const enqueue = () => control.query('SELECT public.enqueue_plugin_state_full_sync($1::text[])', [[repairApp]])
    const jobs = () => control.query("SELECT id::text, kind, ref FROM public.plugin_state_sync_pending WHERE app_id = $1 AND kind = 'full' ORDER BY id", [repairApp])
    await control.query("SELECT set_config('capgo.plugin_state_wake_sent', 'on', false)")
    try {
      await control.query("INSERT INTO public.plugin_state_sync_failed(app_id, kind, ref, repair_at) VALUES($1, 'manifest', '98765', now())", [repairApp])
      await enqueue()
      const first = (await jobs()).rows[0].id
      // Separate committed producer transactions must still coalesce.
      await enqueue()
      expect((await jobs()).rows).toEqual([{ id: first, kind: 'full', ref: '' }])
      expect((await control.query('SELECT app_id FROM public.plugin_state_sync_failed WHERE app_id = $1', [repairApp])).rows).toEqual([])
      expect((await control.query("SELECT ref FROM public.plugin_state_sync_pending WHERE app_id = $1 AND kind = 'manifest'", [repairApp])).rows).toEqual([{ ref: '98765' }])

      await control.query(`UPDATE public.plugin_state_sync_pending SET lease_token = gen_random_uuid(),
        leased_until = now() + interval '2 minutes', attempts = 1, source_commit_at = now() WHERE id = $1`, [first])
      await enqueue()
      expect((await jobs()).rows).toHaveLength(2)
      // A source deferral refunds attempts, but the durable barrier records
      // that the old repair was already claimed and must not absorb a new one.
      await control.query("DELETE FROM public.plugin_state_sync_pending WHERE app_id = $1 AND id <> $2 AND kind = 'full'", [repairApp, first])
      await control.query('UPDATE public.plugin_state_sync_pending SET lease_token = NULL, leased_until = NULL, attempts = 0 WHERE id = $1', [first])
      await enqueue()
      expect((await jobs()).rows).toHaveLength(2)
      await enqueue()
      expect((await jobs()).rows).toHaveLength(2)
    }
    finally {
      await control.query('DELETE FROM public.plugin_state_sync_pending WHERE app_id = $1', [repairApp])
      await control.query('DELETE FROM public.plugin_state_sync_failed WHERE app_id = $1', [repairApp])
      await control.query("SELECT set_config('capgo.plugin_state_wake_sent', '', false)")
    }
  })

  it('serializes concurrent repairs and retains a repair arriving while a claim commits', async () => {
    const repairApp = `${appId}.concurrent-repairs`
    const peer = new Client({ connectionString: POSTGRES_URL })
    await peer.connect()
    await control.query("SELECT set_config('capgo.plugin_state_wake_sent', 'on', false)")
    await peer.query("SELECT set_config('capgo.plugin_state_wake_sent', 'on', false)")
    let pendingRepair: Promise<unknown> | undefined
    try {
      await Promise.all([control, peer].map(client => client.query('SELECT public.enqueue_plugin_state_full_sync($1::text[])', [[repairApp]])))
      const first = (await control.query("SELECT id::text FROM public.plugin_state_sync_pending WHERE app_id = $1 AND kind = 'full'", [repairApp])).rows
      expect(first).toHaveLength(1)
      const controlPid = (await control.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await peer.query('BEGIN')
      await peer.query("SELECT pg_advisory_xact_lock(hashtext('plugin_state_sync_claim'))")
      await peer.query(`UPDATE public.plugin_state_sync_pending SET lease_token = gen_random_uuid(),
        leased_until = now() + interval '2 minutes', attempts = 1,
        source_commit_at = public.reserve_plugin_state_source_barrier() WHERE id = $1`, [first[0].id])
      pendingRepair = control.query('SELECT public.enqueue_plugin_state_full_sync($1::text[])', [[repairApp]])
      let blocked = false
      for (let check = 0; check < 50; check++) {
        const result = await peer.query('SELECT cardinality(pg_blocking_pids($1::integer)) > 0 AS blocked', [controlPid])
        if (result.rows[0].blocked) {
          blocked = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(blocked).toBe(true)
      await peer.query('COMMIT')
      await pendingRepair
      expect((await control.query("SELECT id FROM public.plugin_state_sync_pending WHERE app_id = $1 AND kind = 'full'", [repairApp])).rows).toHaveLength(2)
    }
    finally {
      await peer.query('ROLLBACK')
      await pendingRepair?.catch(() => {})
      await control.query('DELETE FROM public.plugin_state_sync_pending WHERE app_id = $1', [repairApp])
      await control.query("SELECT set_config('capgo.plugin_state_wake_sent', '', false)")
      await peer.end()
    }
  })

  it('bounds deleted-app inventory by distinct app identities even with 5k archived keys for one app', async () => rollback(async () => {
    await enable()
    const prefix = `${appId}.inventory`
    const first = `${prefix}.a`
    const last = `${prefix}.z`
    await control.query("UPDATE public.plugin_state_sync_state SET backfill_after = $1, backfill_done_at = NULL, source_commit_at = NULL, repair_requested = false WHERE id", [prefix])
    await control.query(`INSERT INTO public.plugin_state_sync_failed(app_id, kind, ref, repair_at)
      SELECT $1, 'manifest', n::text, now() FROM generate_series(1,5000) n
      UNION ALL SELECT $2, 'manifest', '5001', now()`, [first, last])
    const page = (await control.query("SELECT public.prepare_plugin_state_inventory('payload') AS page")).rows[0].page
    expect(page.known_ids.slice(0, 2)).toEqual([first, last])
    expect(page.known_ids.length).toBeLessThanOrEqual(25)
  }))

  it('fences inventory pages against replaced scans and caps a page before advancing the primary cursor', async () => rollback(async () => {
    await enable()
    await control.query('DELETE FROM public.plugin_state_sync_pending WHERE app_id = $1', [appId])
    await control.query("UPDATE public.plugin_state_sync_state SET backfill_after = NULL, backfill_done_at = NULL, source_commit_at = NULL WHERE id")
    const page = (await control.query("SELECT public.prepare_plugin_state_inventory('payload') AS page")).rows[0].page
    await control.query('SAVEPOINT oversized')
    await expect(control.query("SELECT public.commit_plugin_state_inventory('payload', NULL, $1, NULL, $2)",
      [page.required_commit_at, Array.from({ length: 26 }, (_, i) => `com.example.page${i}`)])).rejects.toThrow('Invalid plugin state inventory page')
    await control.query('ROLLBACK TO SAVEPOINT oversized')
    const commit = () => control.query("SELECT public.commit_plugin_state_inventory('payload', NULL, $1, NULL, $2) AS ok", [page.required_commit_at, [appId]])
    expect((await commit()).rows[0].ok).toBe(true)
    expect((await commit()).rows[0].ok).toBe(false)
    expect((await control.query('SELECT backfill_after FROM public.plugin_state_sync_state')).rows[0].backfill_after).toBe(appId)
    expect((await control.query('SELECT app_id FROM public.plugin_state_sync_pending WHERE app_id = $1', [appId])).rows).toEqual([{ app_id: appId }])
  }))
})
