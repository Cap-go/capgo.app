import type { PoolClient } from 'pg'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPostgresClient, POSTGRES_URL } from './test-utils.ts'

const APP_ID = `com.test.partialack.${randomUUID()}`
const TOKEN = randomUUID()
let client: PoolClient

async function transaction(run: () => Promise<void>) {
  await client.query('BEGIN')
  try {
    await run()
  }
  finally {
    await client.query('ROLLBACK')
  }
}

async function job(kind: string, ref: string, options: { token?: string | null, attempts?: number, expired?: boolean } = {}) {
  const result = await client.query<{ id: string }>(`INSERT INTO public.plugin_state_sync_pending
    (app_id, kind, ref, due_at, lease_token, leased_until, attempts, producer_xid)
    VALUES ($1, $2, $3, now() - interval '10 years', $4,
      now() + CASE WHEN $5 THEN interval '-1 minute' ELSE interval '2 minutes' END, $6,
      CASE WHEN $4::uuid IS NULL THEN '1'::xid8 ELSE pg_catalog.pg_current_xact_id() END) RETURNING id`,
  [APP_ID, kind, ref, 'token' in options ? options.token : TOKEN, options.expired ?? false, options.attempts ?? 1])
  return result.rows[0].id
}

async function partial(keys: { kind: string, ref: string }[], options: { token?: string, failed?: boolean } = {}) {
  await client.query(`SELECT public.ack_plugin_state_sync_progress(
    p_lease_token => $1::uuid, p_done => '{}'::text[],
    p_deferred => $2::text[], p_failed => $3::text[],
    p_changed_apps => '{}'::text[], p_completed => $4::jsonb)`,
  [options.token ?? TOKEN, options.failed ? [] : [APP_ID], options.failed ? [APP_ID] : [], JSON.stringify({ [APP_ID]: keys })])
}

async function pending() {
  return (await client.query<{ kind: string, ref: string, attempts: number, id: string }>(`SELECT id, kind, ref, attempts
    FROM public.plugin_state_sync_pending WHERE app_id = $1 ORDER BY id`, [APP_ID])).rows
}

async function purges() {
  return (await client.query(`SELECT scope FROM public.updates_cache_purge_pending WHERE app_id = $1`, [APP_ID])).rows
}

describe('plugin state partial-key ACK contracts', () => {
  beforeAll(async () => { client = await (await getPostgresClient()).connect() })
  afterAll(() => client?.release())

  it('persists the purge even when the completed key is the last leased row', async () => {
    await transaction(async () => {
      await job('version', '1.0.0')
      await partial([{ kind: 'version', ref: '1.0.0' }])
      expect(await pending()).toEqual([])
      expect(await purges()).toEqual([{ scope: 'plugin_state' }])
      const status = (await client.query(`SELECT app_synced_at, full_synced_at, synced_at IS NOT NULL AS any_key
        FROM public.plugin_state_sync_apps WHERE app_id = $1`, [APP_ID])).rows
      expect(status).toEqual([{ app_synced_at: null, full_synced_at: null, any_key: true }])
    })
  })

  it('retains incomplete keys, device dependencies, full ownership and newer producer jobs', async () => {
    await transaction(async () => {
      await job('version', '1.0.0')
      const newer = await job('version', '1.0.0', { token: null })
      await job('manifest', '101', { attempts: 4 })
      await job('device', 'fixture-device')
      const cursor = JSON.stringify({ p: 'versions', after: '0.9.0' })
      await job('full', cursor, { attempts: 3 })
      await partial([{ kind: 'version', ref: '1.0.0' }, { kind: 'device', ref: 'fixture-device' }, { kind: 'full', ref: cursor }])
      expect(await pending()).toEqual([
        expect.objectContaining({ id: newer, kind: 'version', attempts: 1 }),
        expect.objectContaining({ kind: 'manifest', ref: '101', attempts: 3 }),
        expect.objectContaining({ kind: 'device', attempts: 0 }),
        expect.objectContaining({ kind: 'full', ref: cursor, attempts: 2 }),
      ])
      expect(await purges()).toEqual([{ scope: 'plugin_state' }])
    })
  })

  it.each(['expired', 'replaced'])('rejects progress from an %s lease', async (state) => {
    await transaction(async () => {
      await job('manifest', '101', state === 'expired' ? { expired: true } : { token: randomUUID() })
      await partial([{ kind: 'manifest', ref: '101' }])
      expect(await pending()).toHaveLength(1)
      expect((await pending())[0].attempts).toBe(1)
      expect(await purges()).toEqual([])
      expect((await client.query('SELECT * FROM public.plugin_state_sync_apps WHERE app_id = $1', [APP_ID])).rows).toEqual([])
    })
  })

  it.each(['replaced', 'expired'])('revalidates a %s lease after waiting for its row lock', async (state) => {
    const blocker = new Client({ connectionString: POSTGRES_URL })
    await blocker.connect()
    try {
      await job('manifest', '101')
      await blocker.query('BEGIN')
      await blocker.query(`UPDATE public.plugin_state_sync_pending SET lease_token = $2
        WHERE app_id = $1`, [APP_ID, state === 'replaced' ? randomUUID() : TOKEN])
      // Start with an activity snapshot that cannot contain the ACK.
      await blocker.query('SELECT pid FROM pg_catalog.pg_stat_activity')
      // Start the stale ACK while its row is locked by the replacement.
      const ack = partial([{ kind: 'manifest', ref: '101' }])
      let waiting = false
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        await blocker.query('SELECT pg_catalog.pg_stat_clear_snapshot()')
        const result = await blocker.query(`SELECT 1 FROM pg_catalog.pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT public.ack_plugin_state_sync_progress(%'`)
        waiting = result.rows.length > 0
        if (!waiting)
          await new Promise(resolve => setTimeout(resolve, 5))
      }
      if (state === 'expired')
        await blocker.query(`UPDATE public.plugin_state_sync_pending SET leased_until = clock_timestamp() - interval '1 microsecond'
          WHERE app_id = $1`, [APP_ID])
      await blocker.query('COMMIT')
      await ack
      expect(waiting).toBe(true)
      expect(await pending()).toHaveLength(1)
      expect(await purges()).toEqual([])
    }
    finally {
      await blocker.query('ROLLBACK')
      await blocker.end()
      await client.query('DELETE FROM public.plugin_state_sync_pending WHERE app_id = $1', [APP_ID])
    }
  })

  it.each(['expired', 'replaced'])('preserves a replacement full-sync marker when a deletion lease is %s', async (state) => {
    await transaction(async () => {
      const previous = (await client.query(`INSERT INTO public.plugin_state_sync_apps
        (app_id, synced_at, app_synced_at, full_synced_at) VALUES ($1, now(), now(), now())
        RETURNING synced_at, app_synced_at, full_synced_at`, [APP_ID])).rows
      await job('app', '', state === 'expired' ? { expired: true } : { token: randomUUID() })
      await client.query(`SELECT public.ack_plugin_state_sync_progress(
        p_lease_token => $1::uuid, p_done => ARRAY[$2]::text[], p_removed => ARRAY[$2]::text[])`, [TOKEN, APP_ID])
      expect((await client.query(`SELECT synced_at, app_synced_at, full_synced_at
        FROM public.plugin_state_sync_apps WHERE app_id = $1`, [APP_ID])).rows).toEqual(previous)
      expect(await purges()).toEqual([])
    })
  })

  it('clears the full-sync marker for a live deletion ACK', async () => {
    await transaction(async () => {
      await client.query(`INSERT INTO public.plugin_state_sync_apps
        (app_id, synced_at, app_synced_at, full_synced_at) VALUES ($1, now(), now(), now())`, [APP_ID])
      await job('app', '')
      await client.query(`SELECT public.ack_plugin_state_sync_progress(
        p_lease_token => $1::uuid, p_done => ARRAY[$2]::text[], p_removed => ARRAY[$2]::text[])`, [TOKEN, APP_ID])
      expect((await client.query(`SELECT full_synced_at FROM public.plugin_state_sync_apps WHERE app_id = $1`, [APP_ID])).rows)
        .toEqual([{ full_synced_at: null }])
      expect(await purges()).toEqual([{ scope: 'plugin_state' }])
    })
  })

  it('retains a newer full request when a live continuation and partial keys settle together', async () => {
    await transaction(async () => {
      await job('version', '1.0.0')
      await job('full', JSON.stringify({ p: 'versions', after: null }))
      const newer = await job('full', '', { token: null })
      const cursor = JSON.stringify({ p: 'devices', after: null })
      await client.query(`SELECT public.ack_plugin_state_sync_progress(
        p_lease_token => $1::uuid, p_done => ARRAY[$2]::text[],
        p_continuations => $3::jsonb, p_completed => $4::jsonb)`,
      [TOKEN, APP_ID, JSON.stringify({ [APP_ID]: cursor }), JSON.stringify({ [APP_ID]: [{ kind: 'version', ref: '1.0.0' }] })])
      expect(await pending()).toEqual([
        expect.objectContaining({ id: newer, kind: 'full', ref: '' }),
        expect.objectContaining({ kind: 'full', ref: cursor }),
      ])
      expect(await purges()).toEqual([{ scope: 'plugin_state' }])
    })
  })

  it('rolls back progress if durable invalidation cannot be inserted', async () => {
    await transaction(async () => {
      await job('manifest', '101')
      await client.query(`CREATE FUNCTION pg_temp.reject_partial_purge() RETURNS trigger
        LANGUAGE plpgsql SET search_path = '' AS $body$ BEGIN
          IF NEW.app_id = '${APP_ID}' THEN RAISE EXCEPTION 'test purge rejected'; END IF;
          RETURN NEW;
        END $body$`)
      await client.query(`CREATE TRIGGER reject_partial_purge BEFORE INSERT ON public.updates_cache_purge_pending
        FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_partial_purge()`)
      await client.query('SAVEPOINT before_ack')
      await expect(partial([{ kind: 'manifest', ref: '101' }])).rejects.toThrow('test purge rejected')
      await client.query('ROLLBACK TO SAVEPOINT before_ack')
      expect(await pending()).toHaveLength(1)
      expect(await purges()).toEqual([])
    })
  })

  it('settles completed keys on failure without refreshing the remaining poison budget', async () => {
    await transaction(async () => {
      await job('version', '1.0.0', { attempts: 5 })
      await job('manifest', '101', { attempts: 5 })
      await partial([{ kind: 'version', ref: '1.0.0' }], { failed: true })
      expect(await pending()).toEqual([])
      expect((await client.query(`SELECT kind, ref FROM public.plugin_state_sync_failed WHERE app_id = $1`, [APP_ID])).rows)
        .toEqual([{ kind: 'manifest', ref: '101' }])
      expect(await purges()).toEqual([{ scope: 'plugin_state' }])
    })
  })

  it('preserves the old worker ACK and its continuation semantics', async () => {
    await transaction(async () => {
      await job('full', '')
      const cursor = JSON.stringify({ p: 'versions', after: '1.0.0' })
      await client.query(`SELECT public.ack_plugin_state_sync(p_lease_token => $1::uuid, p_done => ARRAY[$2]::text[],
        p_continuations => $3::jsonb)`, [TOKEN, APP_ID, JSON.stringify({ [APP_ID]: cursor })])
      expect(await pending()).toEqual([expect.objectContaining({ kind: 'full', ref: cursor, attempts: 0 })])
      expect(await purges()).toEqual([{ scope: 'plugin_state' }])
    })
  })

  it.each(['anon', 'authenticated'])('denies the progress RPC to %s callers', async (role) => {
    await transaction(async () => {
      await client.query(`SET LOCAL ROLE ${role}`)
      await client.query('SAVEPOINT before_denied_ack')
      await expect(client.query(`SELECT public.ack_plugin_state_sync_progress($1::uuid, '{}'::text[])`, [TOKEN]))
        .rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT before_denied_ack')
    })
  })

  it('keeps both ACKs service-only with empty search paths', async () => {
    const { rows } = await client.query(`SELECT p.proname,
      pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
      pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
      pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
      p.prosecdef, p.proconfig, pg_catalog.pg_get_userbyid(p.proowner) AS owner
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('ack_plugin_state_sync', 'ack_plugin_state_sync_progress')`)
    expect(rows).toHaveLength(2)
    for (const row of rows)
      expect(row).toMatchObject({ anon: false, authenticated: false, service: true, prosecdef: true, proconfig: ['search_path=""'], owner: 'postgres' })
  })
})
