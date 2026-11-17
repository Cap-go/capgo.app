import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { env } from 'node:process'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// A disposable database isolates activation settings and queue leases from other files.
const databaseName = `serving_activation_${randomUUID().replaceAll('-', '')}`
const parentUrl = env.SUPABASE_DB_URL ?? env.DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const databaseUrl = new URL(parentUrl)
databaseUrl.pathname = `/${databaseName}`
const admin = new Pool({ connectionString: parentUrl, max: 1 })
const pool = new Pool({ connectionString: databaseUrl.toString(), max: 4, options: '-c statement_timeout=2000 -c lock_timeout=1000' })
const appId = 'com.example.serving.activation'
const epoch = 'serving-test-epoch'
const verified = Object.fromEntries(['EU', 'NA', 'SA', 'OC', 'AS_INDIA', 'AS_JAPAN', 'HK', 'AF', 'ME', 'snippet', 'deno', 'warm_cache', 'colo_attestation', 'load', 'keys'].map(key => [key, true]))

async function activate(client: Pick<Pool, 'query'> = pool) {
  return client.query('SELECT public.activate_serving_policy_publication($1, $2::jsonb)', [epoch, JSON.stringify(verified)])
}

async function saveRestriction() {
  await pool.query('UPDATE public.apps SET serving_regions = $1, serving_region_mode = $2 WHERE app_id = $3', [['EU'], 'block', appId])
}

async function claim() {
  return pool.query<{ token: string, generation: string, app_id: string, active_epoch: string | null }>('SELECT * FROM public.claim_serving_policy_sync()')
}

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${databaseName}`)
  await pool.query(`CREATE SCHEMA private;
    CREATE TABLE private.settings(name text PRIMARY KEY, value text, updated_at timestamptz DEFAULT now());
    CREATE TABLE public.apps(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, app_id text NOT NULL UNIQUE, name text);
    CREATE SEQUENCE public.plugin_state_sync_generation;
    CREATE FUNCTION public.plugin_state_sync_enabled() RETURNS boolean LANGUAGE sql SET search_path = '' AS $$ SELECT false $$;
    CREATE FUNCTION public.wake_plugin_state_sync() RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$ BEGIN RETURN; END $$;`)
  const migrationsUrl = new URL('../supabase/migrations/', import.meta.url)
  const matches = (await readdir(migrationsUrl)).filter(name => name.endsWith('_app_serving_regions.sql'))
  if (matches.length !== 1)
    throw new Error('Expected one serving-regions migration')
  await pool.query(await readFile(new URL(matches[0], migrationsUrl), 'utf8'))
  await pool.query(`CREATE TRIGGER activation_fixture_insert AFTER INSERT ON public.apps
    REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.enqueue_plugin_state_sync();
    CREATE TRIGGER activation_fixture_update AFTER UPDATE ON public.apps
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.enqueue_plugin_state_sync();`)
})

beforeEach(async () => {
  await pool.query(`TRUNCATE public.apps, public.serving_policy_sync_pending, public.serving_policy_sync_failed;
    DELETE FROM private.settings;
    UPDATE public.serving_policy_sync_progress SET epoch = '', after_app = NULL, done_at = now();`)
  await pool.query('INSERT INTO private.settings(name, value) VALUES ($1, $2)', ['CAPGO_SERVING_REGIONS_READER_EPOCH', epoch])
  await pool.query('INSERT INTO public.apps(app_id, name) VALUES ($1, $2)', [appId, 'Activation fixture'])
  await pool.query('DELETE FROM public.serving_policy_sync_pending')
})

afterAll(async () => {
  await pool.end()
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`)
  await admin.end()
})

describe('serving-policy activation and claim serialization', () => {
  it('keeps a concurrent save unclaimed until activation commits, then claims the active restriction', async () => {
    const activation = await pool.connect()
    let transactionOpen = true
    try {
      await activation.query('BEGIN')
      await activate(activation)
      await saveRestriction()
      const duringActivation = (await claim()).rows
      expect((await pool.query('SELECT public.serving_policy_active_epoch() AS epoch')).rows).toEqual([{ epoch: null }])

      await activation.query('COMMIT')
      transactionOpen = false
      await pool.query('SELECT public.serving_policy_sync_tick()')
      // A publisher that already captured preparation must not consume the active sweep's only job.
      for (const preparation of duringActivation)
        await pool.query('SELECT public.ack_serving_policy_sync($1, true)', [preparation.token])
      const claimed = (await claim()).rows
      expect(claimed).toHaveLength(1)
      expect(duringActivation).toEqual([])
      expect(claimed[0]).toMatchObject({ app_id: appId, active_epoch: epoch })
      expect((await pool.query('SELECT serving_regions, serving_region_mode FROM public.apps WHERE app_id = $1', [appId])).rows)
        .toEqual([{ serving_regions: ['EU'], serving_region_mode: 'block' }])
      await pool.query('SELECT public.serving_policy_sync_tick()')
      expect((await pool.query('SELECT count(*)::int AS count FROM public.serving_policy_sync_pending')).rows).toEqual([{ count: 1 }])
      await pool.query('SELECT public.ack_serving_policy_sync($1, true)', [claimed[0].token])
      expect((await pool.query('SELECT count(*)::int AS count FROM public.serving_policy_sync_pending')).rows).toEqual([{ count: 0 }])
    }
    finally {
      if (transactionOpen)
        await activation.query('ROLLBACK')
      activation.release()
    }
  })

  it('refuses activation while another claim transaction still owns admission, without waiting for it', async () => {
    const drainer = await pool.connect()
    try {
      await drainer.query('BEGIN')
      expect((await drainer.query('SELECT * FROM public.claim_serving_policy_sync()')).rows).toEqual([])
      await expect(activate()).rejects.toMatchObject({ code: 'P0001', message: 'Serving policy activation prerequisites incomplete' })
      expect((await pool.query('SELECT public.serving_policy_active_epoch() AS epoch')).rows).toEqual([{ epoch: null }])
    }
    finally {
      await drainer.query('ROLLBACK')
      drainer.release()
    }
    await expect(activate()).resolves.toBeDefined()
  })

  it('retains an already committed preparation claim and refuses activation until it is acknowledged', async () => {
    await saveRestriction()
    const preparation = (await claim()).rows
    expect(preparation).toHaveLength(1)
    expect(preparation[0].active_epoch).toBeNull()
    await expect(activate()).rejects.toMatchObject({ code: 'P0001' })
    expect((await pool.query('SELECT token, attempts FROM public.serving_policy_sync_pending')).rows)
      .toEqual([{ token: preparation[0].token, attempts: 1 }])
    await pool.query('SELECT public.ack_serving_policy_sync($1, true)', [preparation[0].token])
    await activate()
    await pool.query('SELECT public.serving_policy_sync_tick()')
    expect((await claim()).rows[0]).toMatchObject({ app_id: appId, active_epoch: epoch })
  })

  it('releases admission when activation rolls back and retains same-epoch sweep deduplication', async () => {
    const activation = await pool.connect()
    try {
      await activation.query('BEGIN')
      await activate(activation)
      await saveRestriction()
      expect((await claim()).rows).toEqual([])
    }
    finally {
      await activation.query('ROLLBACK')
      activation.release()
    }
    const preparation = (await claim()).rows
    expect(preparation[0].active_epoch).toBeNull()
    await pool.query('SELECT public.ack_serving_policy_sync($1, true)', [preparation[0].token])
    await activate()
    await pool.query('SELECT public.serving_policy_sync_tick()')
    await pool.query('SELECT public.serving_policy_sync_tick()')
    expect((await pool.query('SELECT count(*)::int AS count FROM public.serving_policy_sync_pending')).rows).toEqual([{ count: 1 }])
    const active = (await claim()).rows
    await pool.query('SELECT public.serving_policy_sync_tick()')
    expect((await pool.query('SELECT token FROM public.serving_policy_sync_pending')).rows).toEqual([{ token: active[0].token }])
  })
})
