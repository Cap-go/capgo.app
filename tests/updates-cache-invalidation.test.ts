import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { POSTGRES_URL } from './test-utils.ts'

// Postgres-level coverage for the /updates colo-cache invalidation migration
// (20260711100000): statement-level trigger wiring, bulk-write aggregation,
// notify chunking/cap/dedupe through the pg_net queue, and privileges.

const STATEMENT_TRIGGERS = [
  ['channels', 'invalidate_updates_cache_channels_ins'],
  ['channels', 'invalidate_updates_cache_channels_upd'],
  ['channels', 'invalidate_updates_cache_channels_del'],
  ['channel_devices', 'invalidate_updates_cache_channel_devices_ins'],
  ['channel_devices', 'invalidate_updates_cache_channel_devices_upd'],
  ['channel_devices', 'invalidate_updates_cache_channel_devices_del'],
  ['apps', 'invalidate_updates_cache_apps_ins'],
  ['apps', 'invalidate_updates_cache_apps_upd'],
  ['apps', 'invalidate_updates_cache_apps_del'],
  ['app_versions', 'invalidate_updates_cache_app_versions_upd'],
  ['manifest', 'invalidate_updates_cache_manifest_insert'],
  ['manifest', 'invalidate_updates_cache_manifest_delete'],
  ['orgs', 'invalidate_updates_cache_orgs_upd'],
  ['stripe_info', 'invalidate_updates_cache_stripe_info_ins'],
  ['stripe_info', 'invalidate_updates_cache_stripe_info_upd'],
  ['stripe_info', 'invalidate_updates_cache_stripe_info_del'],
] as const

describe('updates cache invalidation (postgres)', () => {
  let pool: Pool

  beforeAll(() => {
    pool = new Pool({ connectionString: POSTGRES_URL })
  })

  afterAll(async () => {
    await pool.end()
  })

  it.concurrent.each(STATEMENT_TRIGGERS)('wires a statement trigger on %s: %s', async (table, trigger) => {
    const { rows } = await pool.query(`
      SELECT proc.proname AS function_name, trg.tgtype
      FROM pg_trigger trg
      JOIN pg_class tbl ON tbl.oid = trg.tgrelid
      JOIN pg_namespace tbl_ns ON tbl_ns.oid = tbl.relnamespace
      JOIN pg_proc proc ON proc.oid = trg.tgfoid
      WHERE trg.tgname = $1
        AND tbl_ns.nspname = 'public'
        AND tbl.relname = $2
        AND NOT trg.tgisinternal
      LIMIT 1
    `, [trigger, table])
    expect(rows).toHaveLength(1)
    expect(rows[0].function_name).toBe('invalidate_updates_cache_stmt')
    // statement-level triggers have the ROW bit (1) unset in tgtype
    expect(Number(rows[0].tgtype) & 1).toBe(0)
  })

  it.concurrent('does not leave the old row-level implementation behind', async () => {
    const { rows } = await pool.query(`
      SELECT proc.proname
      FROM pg_proc proc
      JOIN pg_namespace ns ON ns.oid = proc.pronamespace
      WHERE ns.nspname = 'public'
        AND proc.proname IN ('invalidate_updates_cache', 'invalidate_updates_cache_manifest')
    `)
    expect(rows).toHaveLength(0)
  })

  it.concurrent('locks down execute privileges on the notify helper', async () => {
    const { rows } = await pool.query(`
      SELECT
        has_function_privilege('anon', 'public.notify_updates_cache_invalidation(text[])', 'EXECUTE') AS anon_execute,
        has_function_privilege('authenticated', 'public.notify_updates_cache_invalidation(text[])', 'EXECUTE') AS authenticated_execute,
        has_function_privilege('service_role', 'public.notify_updates_cache_invalidation(text[])', 'EXECUTE') AS service_role_execute
    `)
    expect(rows[0]).toEqual({
      anon_execute: false,
      authenticated_execute: false,
      service_role_execute: true,
    })
  })

  async function queuedBodiesFor(client: { query: Pool['query'] }, marker: string): Promise<string[][]> {
    const { rows } = await client.query(`
      SELECT convert_from(body, 'utf8')::jsonb -> 'app_ids' AS app_ids
      FROM net.http_request_queue
      WHERE url LIKE '%/triggers/cache_invalidate'
        AND convert_from(body, 'utf8') LIKE $1
      ORDER BY id
    `, [`%${marker}%`])
    return rows.map((row: { app_ids: string[] }) => row.app_ids)
  }

  it.concurrent('notify dedupes and sends one chunked request per 100 apps', async () => {
    const marker = `chunk-${randomUUID()}`
    const appIds = Array.from({ length: 150 }, (_, i) => `${marker}.app.${i % 120}`)
    await pool.query('SELECT public.notify_updates_cache_invalidation($1::text[])', [appIds])
    const bodies = await queuedBodiesFor(pool, marker)
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toHaveLength(100)
    expect(bodies[1]).toHaveLength(20)
    expect(new Set(bodies.flat()).size).toBe(120)
  })

  it.concurrent('notify caps runaway payloads at 1000 apps', async () => {
    const marker = `cap-${randomUUID()}`
    const appIds = Array.from({ length: 1200 }, (_, i) => `${marker}.app.${i}`)
    await pool.query('SELECT public.notify_updates_cache_invalidation($1::text[])', [appIds])
    const bodies = await queuedBodiesFor(pool, marker)
    expect(bodies).toHaveLength(10)
    expect(bodies.flat()).toHaveLength(1000)
  })

  it.concurrent('notify ignores empty input without queueing anything', async () => {
    const marker = `empty-${randomUUID()}`
    await pool.query(`SELECT public.notify_updates_cache_invalidation(ARRAY[]::text[])`)
    await pool.query(`SELECT public.notify_updates_cache_invalidation(ARRAY[NULL, '']::text[])`)
    const bodies = await queuedBodiesFor(pool, marker)
    expect(bodies).toHaveLength(0)
  })

  // The blocker scenario: a bulk cleanup statement touching thousands of
  // channel_devices rows must produce ONE aggregated notification, not one
  // per row — even with the cache mode off, per-row pg_net calls would flood
  // the queue and the fan-out.
  it.concurrent('bulk channel_devices delete produces one aggregated notification', async () => {
    const marker = `bulk-${randomUUID()}`
    const appId = `${marker}.demo.app`
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: [org] } = await client.query(
        `INSERT INTO public.orgs (created_by, name, management_email)
         SELECT id, $1, $2 FROM auth.users LIMIT 1
         RETURNING id, created_by`,
        [`org-${marker}`, `${marker}@test.capgo.app`],
      )
      await client.query(
        `INSERT INTO public.apps (app_id, icon_url, owner_org, name) VALUES ($1, '', $2, $1)`,
        [appId, org.id],
      )
      const { rows: [channel] } = await client.query(
        `INSERT INTO public.channels (name, app_id, owner_org, created_by)
         VALUES ('production', $1, $2, $3) RETURNING id`,
        [appId, org.id, org.created_by],
      )
      // 500 device overrides in one statement
      await client.query(
        `INSERT INTO public.channel_devices (channel_id, app_id, owner_org, device_id)
         SELECT $1, $2, $3, 'dev-' || g.i FROM generate_series(1, 500) AS g(i)`,
        [channel.id, appId, org.id],
      )
      const afterInsert = await queuedBodiesFor(client, marker)
      // one statement-level notification for the bulk insert
      const insertNotifications = afterInsert.filter(body => body.length === 1 && body[0] === appId)
      expect(insertNotifications.length).toBeGreaterThanOrEqual(1)

      // bulk delete: exactly one more notification for this app, not 500
      const before = afterInsert.length
      await client.query(`DELETE FROM public.channel_devices WHERE app_id = $1`, [appId])
      const afterDelete = await queuedBodiesFor(client, marker)
      expect(afterDelete.length).toBe(before + 1)
      expect(afterDelete.at(-1)).toEqual([appId])
      await client.query('ROLLBACK')
    }
    catch (e) {
      await client.query('ROLLBACK')
      throw e
    }
    finally {
      client.release()
    }
  })

  it.concurrent('channels insert queues an invalidation carrying the app_id', async () => {
    const marker = `trg-${randomUUID()}`
    const appId = `${marker}.demo.app`
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: [org] } = await client.query(
        `INSERT INTO public.orgs (created_by, name, management_email)
         SELECT id, $1, $2 FROM auth.users LIMIT 1
         RETURNING id, created_by`,
        [`org-${marker}`, `${marker}@test.capgo.app`],
      )
      await client.query(
        `INSERT INTO public.apps (app_id, icon_url, owner_org, name) VALUES ($1, '', $2, $1)`,
        [appId, org.id],
      )
      await client.query(
        `INSERT INTO public.channels (name, app_id, owner_org, created_by) VALUES ('production', $1, $2, $3)`,
        [appId, org.id, org.created_by],
      )
      const bodies = await queuedBodiesFor(client, marker)
      expect(bodies.length).toBeGreaterThanOrEqual(2) // apps insert + channels insert
      for (const body of bodies)
        expect(body).toContain(appId)
      await client.query('ROLLBACK')
    }
    catch (e) {
      await client.query('ROLLBACK')
      throw e
    }
    finally {
      client.release()
    }
  })
})
