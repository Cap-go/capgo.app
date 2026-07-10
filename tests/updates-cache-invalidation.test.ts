import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { POSTGRES_URL } from './test-utils.ts'

// Postgres-level coverage for the /updates colo-cache invalidation migration
// (20260711100000): trigger wiring, notify chunking/cap/dedupe through the
// pg_net queue, and function privileges.

const ROW_TRIGGER_TABLES = [
  ['channels', 'invalidate_updates_cache_channels'],
  ['channel_devices', 'invalidate_updates_cache_channel_devices'],
  ['apps', 'invalidate_updates_cache_apps'],
  ['app_versions', 'invalidate_updates_cache_app_versions'],
  ['orgs', 'invalidate_updates_cache_orgs'],
  ['stripe_info', 'invalidate_updates_cache_stripe_info'],
] as const

describe('updates cache invalidation (postgres)', () => {
  let pool: Pool

  beforeAll(() => {
    pool = new Pool({ connectionString: POSTGRES_URL })
  })

  afterAll(async () => {
    await pool.end()
  })

  it.concurrent.each(ROW_TRIGGER_TABLES)('wires the row trigger on %s', async (table, trigger) => {
    const { rows } = await pool.query(`
      SELECT proc.proname AS function_name
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
    expect(rows[0].function_name).toBe('invalidate_updates_cache')
  })

  it.concurrent('wires statement-level manifest triggers with transition tables', async () => {
    const { rows } = await pool.query(`
      SELECT trg.tgname, proc.proname AS function_name, trg.tgtype
      FROM pg_trigger trg
      JOIN pg_class tbl ON tbl.oid = trg.tgrelid
      JOIN pg_namespace tbl_ns ON tbl_ns.oid = tbl.relnamespace
      JOIN pg_proc proc ON proc.oid = trg.tgfoid
      WHERE trg.tgname IN ('invalidate_updates_cache_manifest_insert', 'invalidate_updates_cache_manifest_delete')
        AND tbl_ns.nspname = 'public'
        AND tbl.relname = 'manifest'
        AND NOT trg.tgisinternal
      ORDER BY trg.tgname
    `)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.function_name).toBe('invalidate_updates_cache_manifest')
      // statement-level triggers have the ROW bit (1) unset in tgtype
      expect(Number(row.tgtype) & 1).toBe(0)
    }
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

  async function queuedBodiesFor(marker: string): Promise<string[][]> {
    const { rows } = await pool.query(`
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
    const bodies = await queuedBodiesFor(marker)
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toHaveLength(100)
    expect(bodies[1]).toHaveLength(20)
    expect(new Set(bodies.flat()).size).toBe(120)
  })

  it.concurrent('notify caps runaway payloads at 1000 apps', async () => {
    const marker = `cap-${randomUUID()}`
    const appIds = Array.from({ length: 1200 }, (_, i) => `${marker}.app.${i}`)
    await pool.query('SELECT public.notify_updates_cache_invalidation($1::text[])', [appIds])
    const bodies = await queuedBodiesFor(marker)
    expect(bodies).toHaveLength(10)
    expect(bodies.flat()).toHaveLength(1000)
  })

  it.concurrent('notify ignores empty input without queueing anything', async () => {
    const marker = `empty-${randomUUID()}`
    await pool.query(`SELECT public.notify_updates_cache_invalidation(ARRAY[]::text[])`)
    await pool.query(`SELECT public.notify_updates_cache_invalidation(ARRAY[NULL, '']::text[])`)
    const bodies = await queuedBodiesFor(marker)
    expect(bodies).toHaveLength(0)
  })

  it.concurrent('channels trigger queues an invalidation for the app', async () => {
    const marker = `trg-${randomUUID()}`
    const appId = `${marker}.demo.app`
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: [org] } = await client.query(
        `INSERT INTO public.orgs (created_by, name, management_email)
         SELECT id, $1, $2 FROM auth.users LIMIT 1
         RETURNING id`,
        [`org-${marker}`, `${marker}@test.capgo.app`],
      )
      await client.query(
        `INSERT INTO public.apps (app_id, icon_url, owner_org, name)
         VALUES ($1, '', $2, $1)`,
        [appId, org.id],
      )
      await client.query(
        `INSERT INTO public.channels (name, app_id, owner_org, created_by)
         SELECT 'production', $1, $2, created_by FROM public.orgs WHERE id = $2`,
        [appId, org.id],
      )
      // pg_net queue rows are inserted by the trigger inside this
      // transaction; read them before rolling the fixtures back.
      const bodies = await (async () => {
        const { rows } = await client.query(`
          SELECT convert_from(body, 'utf8')::jsonb -> 'app_ids' AS app_ids
          FROM net.http_request_queue
          WHERE url LIKE '%/triggers/cache_invalidate'
            AND convert_from(body, 'utf8') LIKE $1
          ORDER BY id
        `, [`%${marker}%`])
        return rows.map((row: { app_ids: string[] }) => row.app_ids)
      })()
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
