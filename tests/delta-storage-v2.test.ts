import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildManifestSizeLookupQuery, normalizeManifestSizeFiles } from '../supabase/functions/_backend/plugin_runtime/utils/manifest_size.ts'
import { ORG_ID, POSTGRES_URL, resetAndSeedAppData, resetAppData, USER_ID } from './test-utils.ts'

const id = randomUUID()
const APP_ID = `com.delta.storage.v2.${id}`
const pool = new Pool({ connectionString: POSTGRES_URL, max: 4 })
let versionCounter = 0

async function insertVersion(client: Pick<PoolClient, 'query'>, options: { deleted?: boolean, deletedAt?: string, storageProvider?: string } = {}) {
  versionCounter++
  const result = await client.query<{ id: string }>(
    `INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider, deleted, deleted_at, checksum)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8)
     RETURNING id`,
    [APP_ID, `1.0.${versionCounter}-${id.slice(0, 8)}`, ORG_ID, USER_ID, options.storageProvider ?? 'r2', options.deleted ?? false, options.deletedAt ?? null, randomUUID().replaceAll('-', '')],
  )
  return Number(result.rows[0].id)
}

function deltaPath(name: string) {
  return `orgs/${ORG_ID}/apps/${APP_ID}/delta/${name}`
}

async function insertLegacyRows(versionId: number, names: string[]) {
  await pool.query(
    `INSERT INTO public.manifest (app_version_id, file_name, file_hash, s3_path, file_size)
     SELECT $1, name, 'hash-' || name, $2 || name, 10 FROM unnest($3::text[]) AS name`,
    [versionId, `orgs/${ORG_ID}/apps/${APP_ID}/delta/`, names],
  )
}

// No in-progress upload left by other cases.
async function readyForDeletes(client: Pick<PoolClient, 'query'>) {
  await client.query(`UPDATE public.app_versions SET storage_provider = 'r2' WHERE app_id = $1 AND storage_provider = 'r2-direct'`, [APP_ID])
}

// What delta_gc_begin_delete records before any R2 request is sent.
async function recordUnsettled(client: Pick<PoolClient, 'query'>, paths: string[]) {
  await client.query(
    `INSERT INTO public.delta_gc_unsettled_deletes (path, app_id) SELECT path, $1 FROM unnest($2::text[]) AS path
     ON CONFLICT (path) DO UPDATE SET recorded_at = now(), checks = 0`,
    [APP_ID, paths],
  )
}

async function versionFiles(versionId: number) {
  const result = await pool.query<{ s3_path: string }>(
    `SELECT df.s3_path
     FROM public.version_files vf
     CROSS JOIN LATERAL unnest(vf.file_ids) WITH ORDINALITY AS entry(file_id, ord)
     INNER JOIN public.delta_files df ON df.id = entry.file_id
     WHERE vf.app_version_id = $1
     ORDER BY entry.ord`,
    [versionId],
  )
  return result.rows.map(row => row.s3_path)
}

const SWITCHES = {
  gc_enabled: 'CAPGO_DELTA_STORAGE_GC_ENABLED',
} as const

async function setSwitch(client: Pick<PoolClient, 'query'>, name: keyof typeof SWITCHES, value: boolean) {
  await client.query('DELETE FROM vault.secrets WHERE name = $1', [SWITCHES[name]])
  await client.query('SELECT vault.create_secret($1, $2)', [String(value), SWITCHES[name]])
}

// The Vault switches stay untouched for parallel test files: each case sets
// them inside its own transaction and rolls back.
async function withConfig<T>(settings: { gc_enabled?: boolean }, run: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const name of Object.keys(SWITCHES) as Array<keyof typeof SWITCHES>) {
      if (settings[name] !== undefined)
        await setSwitch(client, name, settings[name])
    }
    return await run(client)
  }
  finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

// Makes only this file's app the first due one and claims a single app, so
// apps owned by parallel test files are neither required nor touched.
async function claimOwnApp(client: Pick<PoolClient, 'query'>) {
  await client.query(`UPDATE public.delta_gc_state SET next_run_at = '-infinity' WHERE app_id = $1`, [APP_ID])
  const claimed = await client.query<{ app_id: string, list_org: string }>('SELECT app_id, list_org FROM public.delta_gc_claim(1)')
  return claimed.rows.filter(row => row.app_id === APP_ID)
}

// Walks one GC pass of this app; finishing a page with no cursor advances to
// the next organization prefix until the pass is scheduled a week out.
async function walkPass(client: Pick<PoolClient, 'query'>) {
  const seen: string[] = []
  for (let page = 0; page < 5; page++) {
    const [claimed] = await claimOwnApp(client)
    if (!claimed)
      break
    seen.push(claimed.list_org)
    await client.query('SELECT public.delta_gc_finish($1, NULL, NULL)', [APP_ID])
    const done = await client.query(`SELECT next_run_at > now() + interval '6 days' AS weekly FROM public.delta_gc_state WHERE app_id = $1`, [APP_ID])
    if (done.rows[0].weekly)
      break
  }
  return seen
}

beforeAll(async () => {
  await resetAndSeedAppData(APP_ID)
})

afterAll(async () => {
  await resetAppData(APP_ID)
  await pool.end()
})

describe('delta storage v2 compatibility view', () => {
  it('stores rows written through the manifest compatibility view once per unique file', async () => {
    const first = await insertVersion(pool)
    const second = await insertVersion(pool)
    await insertLegacyRows(first, ['a.js', 'b.js'])
    await insertLegacyRows(second, ['b.js', 'c.js'])

    expect(await versionFiles(first)).toEqual([deltaPath('a.js'), deltaPath('b.js')])
    expect(await versionFiles(second)).toEqual([deltaPath('b.js'), deltaPath('c.js')])
    const files = await pool.query('SELECT count(*)::int AS count FROM public.delta_files WHERE app_id = $1 AND s3_path = ANY($2::text[])', [APP_ID, [deltaPath('a.js'), deltaPath('b.js'), deltaPath('c.js')]])
    expect(files.rows[0].count).toBe(3)
    // Published CLIs read the same entries back through the view.
    const legacy = await pool.query('SELECT file_name FROM public.manifest WHERE app_version_id = $1 ORDER BY file_name', [first])
    expect(legacy.rows.map(row => row.file_name)).toEqual(['a.js', 'b.js'])
    // Deletes through the view are ignored: GC owns file removal.
    await pool.query('DELETE FROM public.manifest WHERE app_version_id = $1', [first])
    expect(await versionFiles(first)).toEqual([deltaPath('a.js'), deltaPath('b.js')])

    const view = await pool.query('SELECT file_name FROM public.version_manifest WHERE app_version_id = $1 ORDER BY id', [second])
    expect(view.rows.map(row => row.file_name)).toEqual(['b.js', 'c.js'])
  })


})

describe('delta storage v2 GC guards', () => {
  it('keeps paths of live versions and versions deleted less than 7 days ago', async () => {
    const live = await insertVersion(pool)
    const recent = await insertVersion(pool, { deleted: true, deletedAt: new Date(Date.now() - 2 * 86400_000).toISOString() })
    const old = await insertVersion(pool, { deleted: true, deletedAt: new Date(Date.now() - 9 * 86400_000).toISOString() })
    await insertLegacyRows(live, ['live.js'])
    await insertLegacyRows(recent, ['recent.js'])
    await insertLegacyRows(old, ['old.js', 'live.js'])

    const result = await pool.query<{ paths: string[] }>(
      'SELECT public.delta_gc_unreferenced_paths($1::text[]) AS paths',
      [[deltaPath('live.js'), deltaPath('recent.js'), deltaPath('old.js'), deltaPath('orphan.js')]],
    )
    expect(result.rows[0].paths.sort()).toEqual([deltaPath('old.js'), deltaPath('orphan.js')].sort())
  })

  it('keeps an object referenced under any spelling /files/read accepts', async () => {
    await withConfig({}, async (client) => {
      const sha = 'a'.repeat(64)
      const versionId = await insertVersion(client)
      // Stored spellings: decoded dotfile, encoded "@", partially encoded name.
      const stored = [`${sha}_.htaccess`, `${sha}_image%402x.png`, `${sha}_a%20b@c.js`]
      for (const name of stored) {
        await client.query(
          `INSERT INTO public.manifest (app_version_id, file_name, file_hash, s3_path, file_size) VALUES ($1, $2::text, 'h', $3, 1)`,
          [versionId, name, deltaPath(name)],
        )
      }

      // Physical keys listed by GC in other spellings of the same objects.
      const listed = [`${sha}_%2Ehtaccess`, `${sha}_%2ehtaccess`, `${sha}_image@2x.png`, `${sha}_image%25402x.png`, `${sha}_a b%40c.js`].map(deltaPath)
      const result = await client.query<{ paths: string[] }>('SELECT public.delta_gc_unreferenced_paths($1::text[]) AS paths', [[...listed, deltaPath(`${sha}_other.js`)]])
      expect(result.rows[0].paths).toEqual([deltaPath(`${sha}_other.js`)])
      // Invalid escapes still resolve the dotfile spelling.
      const invalid = await client.query<{ path: string }>(`SELECT public.delta_canonical_path('a/%2Ehtaccess%ZZ%C3') AS path`)
      expect(invalid.rows[0].path).toBe('a/.htaccess%ZZ%C3')
    })
  })

  it('never runs the path key functions in parallel workers', async () => {
    // A PostgreSQL 17 worker that took delta_canonical_path's EXCEPTION branch
    // returns later paths undecoded.
    const result = await pool.query<{ proname: string, proparallel: string }>(
      `SELECT proname, proparallel FROM pg_catalog.pg_proc
       WHERE pronamespace = 'public'::regnamespace AND proname IN ('delta_canonical_path', 'delta_path_key')
       ORDER BY proname`,
    )
    expect(result.rows).toEqual([
      { proname: 'delta_canonical_path', proparallel: 'r' },
      { proname: 'delta_path_key', proparallel: 'r' },
    ])
  })

  it('restores a deleted version\'s counters and queues its missing size lookups', async () => {
    await withConfig({}, async (client) => {
      const path = deltaPath('restore-unsized.js')
      const versionId = await insertVersion(client, { deleted: true, deletedAt: new Date(Date.now() - 86400_000).toISOString() })
      await client.query(
        `INSERT INTO public.manifest (app_version_id, file_name, file_hash, s3_path, file_size) VALUES ($1, 'restore-unsized.js', 'h', $2, 0)`,
        [versionId, path],
      )
      // A version deleted less than 7 days ago keeps its files.
      const kept = await client.query<{ paths: string[] }>('SELECT public.delta_gc_unreferenced_paths($1::text[]) AS paths', [[path]])
      expect(kept.rows[0].paths).toEqual([])

      // Drop the lookup the insert queued, as if it had run while the file was missing.
      await client.query(`DELETE FROM pgmq.q_on_manifest_create WHERE message->'payload'->'record'->>'s3_path' = $1`, [path])
      const before = await client.query<{ count: number }>('SELECT manifest_bundle_count AS count FROM public.apps WHERE app_id = $1', [APP_ID])
      await client.query('UPDATE public.app_versions SET deleted = false, deleted_at = NULL WHERE id = $1', [versionId])
      const restored = await client.query<{ manifest_count: number }>('SELECT manifest_count FROM public.app_versions WHERE id = $1', [versionId])
      expect(restored.rows[0].manifest_count).toBe(1)
      const queued = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pgmq.q_on_manifest_create
         WHERE message->'payload'->>'table' = 'delta_files' AND message->'payload'->'record'->>'s3_path' = $1`,
        [path],
      )
      expect(queued.rows[0].count).toBe(1)
      const after = await client.query<{ count: number }>('SELECT manifest_bundle_count AS count FROM public.apps WHERE app_id = $1', [APP_ID])
      expect(Number(after.rows[0].count)).toBe(Number(before.rows[0].count) + 1)
    })
  })


  it('never opens a delete lease while GC is disabled or an upload is in progress', async () => {
    const orphan = deltaPath('lease-orphan.js')
    const disabled = await pool.query<{ paths: string[] }>('SELECT public.delta_gc_begin_delete($1, $2::text[], 1000) AS paths', [APP_ID, [orphan]])
    expect(disabled.rows[0].paths).toEqual([])

    await withConfig({ gc_enabled: true }, async (client) => {
      await readyForDeletes(client)
      await insertVersion(client, { storageProvider: 'r2-direct' })
      const blocked = await client.query<{ paths: string[] }>('SELECT public.delta_gc_begin_delete($1, $2::text[], 1000) AS paths', [APP_ID, [orphan]])
      expect(blocked.rows[0].paths).toEqual([])
    })

    await withConfig({ gc_enabled: true }, async (client) => {
      await readyForDeletes(client)
      const allowed = await client.query<{ paths: string[] }>('SELECT public.delta_gc_begin_delete($1, $2::text[], 1000) AS paths', [APP_ID, [orphan]])
      expect(allowed.rows[0].paths).toEqual([orphan])
      const lease = await client.query('SELECT lease_until > clock_timestamp() AS active FROM public.delta_gc_state WHERE app_id = $1', [APP_ID])
      expect(lease.rows[0].active).toBe(true)
    })
  })

  it('schedules a GC pass 7 days after a version is deleted', async () => {
    await withConfig({}, async (client) => {
      const versionId = await insertVersion(client)
      await client.query(`UPDATE public.delta_gc_state SET next_run_at = now() + interval '30 days' WHERE app_id = $1`, [APP_ID])
      await client.query('UPDATE public.app_versions SET deleted = true WHERE id = $1', [versionId])
      const state = await client.query(`SELECT next_run_at BETWEEN now() + interval '7 days' AND now() + interval '7 days 2 hours' AS scheduled FROM public.delta_gc_state WHERE app_id = $1`, [APP_ID])
      expect(state.rows[0].scheduled).toBe(true)
    })
  })

  it('makes a new upload wait for an active delete lease', async () => {
    await pool.query(`UPDATE public.delta_gc_state SET lease_until = clock_timestamp() + interval '1500 milliseconds' WHERE app_id = $1`, [APP_ID])
    const startedAt = Date.now()
    await insertVersion(pool)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1000)
    await pool.query('UPDATE public.delta_gc_state SET lease_until = NULL WHERE app_id = $1', [APP_ID])
  })

  it('serializes the delete decision behind an uncommitted upload of the same app', async () => {
    const uploader = await pool.connect()
    const collector = await pool.connect()
    try {
      await uploader.query('BEGIN')
      await insertVersion(uploader, { storageProvider: 'r2-direct' })

      await collector.query('BEGIN')
      await setSwitch(collector, 'gc_enabled', true)
      const decision = collector.query<{ paths: string[] }>('SELECT public.delta_gc_begin_delete($1, $2::text[], 1000) AS paths', [APP_ID, [deltaPath('race.js')]])
      // The collector waits on the per-app lock until the upload commits, then sees it.
      await new Promise(resolve => setTimeout(resolve, 300))
      await uploader.query('COMMIT')
      expect((await decision).rows[0].paths).toEqual([])
    }
    finally {
      await uploader.query('ROLLBACK')
      await collector.query('ROLLBACK')
      uploader.release()
      collector.release()
      await pool.query(`UPDATE public.app_versions SET storage_provider = 'r2' WHERE app_id = $1 AND storage_provider = 'r2-direct'`, [APP_ID])
    }
  })
})

describe('delta storage v2 legacy guards', () => {
  it('lets delta-only channels and jsonb clearing see converted versions', async () => {
    const versionId = await insertVersion(pool)
    await insertLegacyRows(versionId, ['guard.js'])

    const mismatch = await pool.query<{ reason: string | null }>(
      `SELECT public.channel_update_package_mismatch('delta'::public.channel_update_package, $1, 'production') AS reason`,
      [versionId],
    )
    expect(mismatch.rows[0].reason).toBeNull()

    const unmigrated = await pool.query<{ unmigrated: boolean }>(
      `SELECT public.app_version_manifest_jsonb_unmigrated($1, ARRAY[ROW('guard.js', $2, 'hash-guard.js')::public.manifest_entry]) AS unmigrated`,
      [versionId, deltaPath('guard.js')],
    )
    expect(unmigrated.rows[0].unmigrated).toBe(false)
  })


  it('postpones GC for apps with a live inline jsonb manifest', async () => {
    await withConfig({ gc_enabled: true }, async (client) => {
      await client.query(
        `INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider, checksum, manifest)
         VALUES ($1, $2, $3, $4, 'r2', $5, ARRAY[ROW('inline.js', $6, 'hash')::public.manifest_entry])`,
        [APP_ID, `9.9.9-inline-${id.slice(0, 8)}`, ORG_ID, USER_ID, randomUUID().replaceAll('-', ''), deltaPath('inline.js')],
      )
      expect(await claimOwnApp(client)).toEqual([])
      // Postponed until the upload flow moves the inline list.
      const state = await client.query(`SELECT next_run_at > now() + interval '23 hours' AS postponed FROM public.delta_gc_state WHERE app_id = $1`, [APP_ID])
      expect(state.rows[0].postponed).toBe(true)
    })
  })

  it('lists every former owner prefix of a transferred app in one pass', async () => {
    const formerOrg = '00000000-0000-4000-8000-0000000000aa'
    await withConfig({ gc_enabled: true }, async (client) => {
      await client.query(`DELETE FROM public.app_versions WHERE app_id = $1 AND manifest IS NOT NULL`, [APP_ID])
      await client.query(
        `INSERT INTO public.delta_files (app_id, s3_path, file_name, file_hash, path_key, entry_key)
         VALUES ($1, $2::text, 'old.js', 'h', public.delta_path_key($2::text), public.delta_entry_key($2::text, 'old.js', 'h'))`,
        [APP_ID, `orgs/${formerOrg}/apps/${APP_ID}/delta/old.js`],
      )
      await client.query(`UPDATE public.delta_gc_state SET list_org = NULL, pending_orgs = NULL, list_cursor = NULL WHERE app_id = $1`, [APP_ID])
      expect(await walkPass(client)).toEqual([formerOrg, ORG_ID].sort())

      // The former owner stays known after its last delta_files row is gone.
      await client.query('DELETE FROM public.delta_files WHERE app_id = $1 AND s3_path LIKE $2', [APP_ID, `orgs/${formerOrg}/%`])
      expect(await walkPass(client)).toEqual([formerOrg, ORG_ID].sort())
      const state = await client.query(`SELECT list_org, next_run_at > now() + interval '6 days' AS weekly FROM public.delta_gc_state WHERE app_id = $1`, [APP_ID])
      expect(state.rows[0]).toEqual({ list_org: null, weekly: true })
    })
  })

  it('records former-owner prefixes when an app is deleted and drops re-created ones', async () => {
    const formerOrg = '00000000-0000-4000-8000-0000000000bb'
    const goneApp = `com.delta.storage.gone.${id}`
    await withConfig({ gc_enabled: true }, async (client) => {
      await client.query(`INSERT INTO public.apps (app_id, owner_org, name, icon_url) VALUES ($1, $2, 'gone', '')`, [goneApp, ORG_ID])
      await client.query(
        `INSERT INTO public.delta_files (app_id, s3_path, file_name, file_hash, path_key, entry_key)
         VALUES ($1, $2::text, 'old.js', 'h', public.delta_path_key($2::text), public.delta_entry_key($2::text, 'old.js', 'h'))`,
        [goneApp, `orgs/${formerOrg}/apps/${goneApp}/delta/old.js`],
      )
      // A row written through the compatibility view under a second former owner.
      const legacyOrg = '00000000-0000-4000-8000-0000000000cc'
      const [{ id: goneVersion }] = (await client.query<{ id: string }>(
        `INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider, checksum)
         VALUES ($1, '1.0.0', $2, $3, 'r2', 'c') RETURNING id`,
        [goneApp, ORG_ID, USER_ID],
      )).rows
      await client.query(
        `INSERT INTO public.manifest (app_version_id, file_name, file_hash, s3_path, file_size) VALUES ($1, 'l.js', 'h', $2, 1)`,
        [goneVersion, `orgs/${legacyOrg}/apps/${goneApp}/delta/l.js`],
      )
      await client.query('DELETE FROM public.apps WHERE app_id = $1', [goneApp])
      const recorded = await client.query<{ org: string }>('SELECT org FROM public.delta_gc_orphan_prefixes WHERE app_id = $1 ORDER BY org', [goneApp])
      expect(recorded.rows.map(row => row.org)).toEqual([formerOrg, legacyOrg].sort())
      const claimed = await client.query<{ prefix: string }>('SELECT prefix FROM public.delta_gc_claim_orphan_prefixes(50)')
      expect(claimed.rows.map(row => row.prefix)).toContain(`orgs/${formerOrg}/apps/${goneApp}/`)
      await client.query('SELECT public.delta_gc_finish_orphan_prefix($1, NULL)', [`orgs/${formerOrg}/apps/${goneApp}/`])
      await client.query('SELECT public.delta_gc_finish_orphan_prefix($1, NULL)', [`orgs/${legacyOrg}/apps/${goneApp}/`])
      const left = await client.query('SELECT count(*)::int AS count FROM public.delta_gc_orphan_prefixes WHERE app_id = $1', [goneApp])
      expect(left.rows[0].count).toBe(0)
    })
  })

  it('keeps an active delete lease on the orphan prefixes of a deleted app', async () => {
    const formerOrg = '00000000-0000-4000-8000-0000000000dd'
    const leasedApp = `com.delta.storage.leased.${id}`
    await withConfig({ gc_enabled: true }, async (client) => {
      await client.query(`INSERT INTO public.apps (app_id, owner_org, name, icon_url) VALUES ($1, $2, 'leased', '')`, [leasedApp, ORG_ID])
      await client.query(
        `INSERT INTO public.delta_files (app_id, s3_path, file_name, file_hash, path_key, entry_key)
         VALUES ($1, $2::text, 'a.js', 'h', public.delta_path_key($2::text), public.delta_entry_key($2::text, 'a.js', 'h'))`,
        [leasedApp, `orgs/${formerOrg}/apps/${leasedApp}/delta/a.js`],
      )
      // GC authorized deletes under the former owner's prefix and holds the lease.
      await client.query(`UPDATE public.delta_gc_state SET lease_until = clock_timestamp() + interval '2 seconds' WHERE app_id = $1`, [leasedApp])
      await client.query('DELETE FROM public.apps WHERE app_id = $1', [leasedApp])
      const orphan = await client.query<{ active: boolean }>(
        'SELECT lease_until > clock_timestamp() AS active FROM public.delta_gc_orphan_prefixes WHERE app_id = $1',
        [leasedApp],
      )
      // A re-created app id waits for that lease (delta_gc_wait_for_lease reads it).
      expect(orphan.rows).toEqual([{ active: true }])
    })
  })

  it('keeps cleanup progress when a page is cut short', async () => {
    await withConfig({ gc_enabled: true }, async (client) => {
      await client.query(`INSERT INTO public.delta_gc_orphan_prefixes (prefix, app_id, org) VALUES ('orgs/x/apps/partial/', 'partial', 'x')`)
      await client.query(`SELECT public.delta_gc_finish_orphan_prefix('orgs/x/apps/partial/', NULL, false)`)
      const kept = await client.query(`SELECT list_cursor, claimed_until FROM public.delta_gc_orphan_prefixes WHERE prefix = 'orgs/x/apps/partial/'`)
      expect(kept.rows).toEqual([{ list_cursor: null, claimed_until: null }])
      await client.query(`SELECT public.delta_gc_finish_orphan_prefix('orgs/x/apps/partial/', NULL, true)`)
      const gone = await client.query(`SELECT 1 FROM public.delta_gc_orphan_prefixes WHERE prefix = 'orgs/x/apps/partial/'`)
      expect(gone.rows).toEqual([])

      await client.query(`UPDATE public.delta_gc_state SET list_org = 'org-a', pending_orgs = ARRAY['org-b'], list_cursor = NULL WHERE app_id = $1`, [APP_ID])
      await client.query('SELECT public.delta_gc_finish($1, NULL, NULL, false)', [APP_ID])
      const state = await client.query(`SELECT list_org, pending_orgs, next_run_at <= now() AS soon FROM public.delta_gc_state WHERE app_id = $1`, [APP_ID])
      expect(state.rows[0]).toEqual({ list_org: 'org-a', pending_orgs: ['org-b'], soon: true })
    })
  })

  it('keeps an active delete lease when a page is finished', async () => {
    await withConfig({ gc_enabled: true }, async (client) => {
      await client.query(`UPDATE public.delta_gc_state SET lease_until = clock_timestamp() + interval '2 seconds' WHERE app_id = $1`, [APP_ID])
      await client.query('SELECT public.delta_gc_finish($1, NULL, NULL)', [APP_ID])
      await client.query(`SELECT public.delta_gc_finish($1, NULL, 'boom')`, [APP_ID])
      const lease = await client.query('SELECT lease_until > clock_timestamp() AS active FROM public.delta_gc_state WHERE app_id = $1', [APP_ID])
      expect(lease.rows[0].active).toBe(true)
    })
  })

  it('reports whether an unsettled delete is referenced again', async () => {
    await withConfig({}, async (client) => {
      const versionId = await insertVersion(client)
      await client.query(
        `INSERT INTO public.manifest (app_version_id, file_name, file_hash, s3_path, file_size) VALUES ($1, 'again.js', 'h', $2, 1)`,
        [versionId, deltaPath('again.js')],
      )
      await recordUnsettled(client, [deltaPath('again.js'), deltaPath('gone.js')])
      await client.query(`UPDATE public.delta_gc_unsettled_deletes SET recorded_at = now() - interval '2 minutes' WHERE app_id = $1`, [APP_ID])
      const claimed = await client.query<{ path: string, referenced: boolean }>('SELECT path, referenced FROM public.delta_gc_claim_unsettled(50) ORDER BY path')
      expect(claimed.rows.filter(row => row.path.startsWith(deltaPath(''))).map(row => [row.path, row.referenced]))
        .toEqual([[deltaPath('again.js'), true], [deltaPath('gone.js'), false]])
      await client.query('SELECT public.delta_gc_settle($1, false)', [deltaPath('gone.js')])
      const left = await client.query('SELECT path FROM public.delta_gc_unsettled_deletes WHERE path LIKE $1', [`${deltaPath('')}%`])
      expect(left.rows.map(row => row.path)).toEqual([deltaPath('again.js')])

      // An in-progress upload of the app may reuse the key before its
      // version_files row exists: the path counts as referenced meanwhile.
      await recordUnsettled(client, [deltaPath('pending.js')])
      await client.query(`UPDATE public.delta_gc_unsettled_deletes SET recorded_at = now() - interval '2 minutes' WHERE path = $1`, [deltaPath('pending.js')])
      await insertVersion(client, { storageProvider: 'r2-direct' })
      const pending = await client.query<{ referenced: boolean }>('SELECT referenced FROM public.delta_gc_claim_unsettled(50) WHERE path = $1', [deltaPath('pending.js')])
      expect(pending.rows).toEqual([{ referenced: true }])
      await client.query(`UPDATE public.app_versions SET storage_provider = 'r2' WHERE app_id = $1 AND storage_provider = 'r2-direct'`, [APP_ID])
      await client.query('SELECT public.delta_gc_settle($1, false)', [deltaPath('pending.js')])

      // A referenced object seen present is kept for later checks: a DELETE
      // applied after this check is still caught by the 1 hour / 1 day ones.
      for (const [check, wait] of [[1, '1 hour'], [2, '1 day']] as const) {
        await client.query('SELECT public.delta_gc_settle($1, true)', [deltaPath('again.js')])
        const kept = await client.query<{ checks: number }>('SELECT checks FROM public.delta_gc_unsettled_deletes WHERE path = $1', [deltaPath('again.js')])
        expect(kept.rows[0].checks).toBe(check)
        const early = await client.query('SELECT path FROM public.delta_gc_claim_unsettled(50) WHERE path = $1', [deltaPath('again.js')])
        expect(early.rows).toEqual([])
        await client.query(`UPDATE public.delta_gc_unsettled_deletes SET recorded_at = now() - interval '${wait}' - interval '1 minute' WHERE path = $1`, [deltaPath('again.js')])
        const due = await client.query('SELECT path FROM public.delta_gc_claim_unsettled(50) WHERE path = $1', [deltaPath('again.js')])
        expect(due.rows).toHaveLength(1)
      }
      await client.query('SELECT public.delta_gc_settle($1, true)', [deltaPath('again.js')])
      const done = await client.query('SELECT 1 FROM public.delta_gc_unsettled_deletes WHERE path = $1', [deltaPath('again.js')])
      expect(done.rows).toEqual([])
    })
  })

  it('records delete intent with the lease and forgets it only once confirmed', async () => {
    await withConfig({ gc_enabled: true }, async (client) => {
      await readyForDeletes(client)
      const paths = [deltaPath('intent-a.js'), deltaPath('intent-b.js')]
      const begin = await client.query<{ paths: string[] }>('SELECT public.delta_gc_begin_delete($1, $2::text[], 1000) AS paths', [APP_ID, paths])
      expect(begin.rows[0].paths.sort()).toEqual([...paths].sort())
      const recorded = await client.query('SELECT path FROM public.delta_gc_unsettled_deletes WHERE path = ANY($1::text[]) ORDER BY path', [paths])
      expect(recorded.rows.map(row => row.path)).toEqual([...paths].sort())
      await client.query('SELECT public.delta_gc_confirm_deleted($1::text[])', [[paths[0]]])
      const left = await client.query('SELECT path FROM public.delta_gc_unsettled_deletes WHERE path = ANY($1::text[])', [paths])
      expect(left.rows.map(row => row.path)).toEqual([paths[1]])

      // An overlapping run cannot start a batch while this lease is active.
      const overlapping = await client.query<{ paths: string[] | null }>('SELECT public.delta_gc_begin_delete($1, $2::text[], 1000) AS paths', [APP_ID, [deltaPath('intent-c.js')]])
      expect(overlapping.rows[0].paths).toBeNull()
      // After the lease, a batch with a path whose earlier delete is unsettled
      // is retried later rather than skipping that path.
      await client.query('SELECT public.delta_gc_end_delete($1)', [APP_ID])
      const retry = await client.query<{ paths: string[] | null }>('SELECT public.delta_gc_begin_delete($1, $2::text[], 1000) AS paths', [APP_ID, [paths[1], deltaPath('intent-c.js')]])
      expect(retry.rows[0].paths).toBeNull()
      const clean = await client.query<{ paths: string[] }>('SELECT public.delta_gc_begin_delete($1, $2::text[], 1000) AS paths', [APP_ID, [deltaPath('intent-c.js')]])
      expect(clean.rows[0].paths).toEqual([deltaPath('intent-c.js')])
    })
  })

  it('refuses deletes while a recently deleted version still has an inline manifest', async () => {
    await withConfig({ gc_enabled: true }, async (client) => {
      await readyForDeletes(client)
      // Bundle content is immutable once ready: the inline manifest is set on insert.
      const [{ id: versionId }] = (await client.query<{ id: string }>(
        `INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider, deleted, deleted_at, checksum, manifest)
         VALUES ($1, $2, $3, $4, 'r2', true, now() - interval '1 day', 'c', ARRAY[ROW('inline.js', $5, 'h')::public.manifest_entry])
         RETURNING id`,
        [APP_ID, `inline-${id.slice(0, 8)}`, ORG_ID, USER_ID, deltaPath('inline.js')],
      )).rows
      const refused = await client.query<{ paths: string[] }>('SELECT public.delta_gc_begin_delete($1, $2::text[], 1000) AS paths', [APP_ID, [deltaPath('inline.js')]])
      expect(refused.rows[0].paths).toEqual([])

      // Past the 7-day window the inline manifest no longer keeps files.
      await client.query(`UPDATE public.app_versions SET deleted_at = now() - interval '8 days' WHERE id = $1`, [versionId])
      const allowed = await client.query<{ paths: string[] }>('SELECT public.delta_gc_begin_delete($1, $2::text[], 1000) AS paths', [APP_ID, [deltaPath('inline.js')]])
      expect(allowed.rows[0].paths).toEqual([deltaPath('inline.js')])
    })
  })

  it('drains orphan prefixes under a lease and drops them when the app id is back in that org', async () => {
    await withConfig({ gc_enabled: true }, async (client) => {
      const formerOrg = randomUUID()
      const orphan = `orgs/${formerOrg}/apps/${APP_ID}/`
      const own = `orgs/${ORG_ID}/apps/${APP_ID}/`
      await client.query('INSERT INTO public.delta_gc_orphan_prefixes (prefix, app_id, org) VALUES ($1, $2, $3), ($4, $2, $5)', [orphan, APP_ID, formerOrg, own, ORG_ID])
      await readyForDeletes(client)

      const begin = await client.query<{ paths: string[] | null }>(
        'SELECT public.delta_gc_begin_orphan_delete($1, $2::text[], 1000) AS paths',
        [orphan, [`${orphan}delta/x.js`, `${own}delta/outside.js`]],
      )
      expect(begin.rows[0].paths).toEqual([`${orphan}delta/x.js`])
      const lease = await client.query('SELECT lease_until > clock_timestamp() AS active FROM public.delta_gc_orphan_prefixes WHERE prefix = $1', [orphan])
      expect(lease.rows[0].active).toBe(true)
      await client.query('SELECT public.delta_gc_end_orphan_delete($1)', [orphan])
      const ended = await client.query('SELECT lease_until FROM public.delta_gc_orphan_prefixes WHERE prefix = $1', [orphan])
      expect(ended.rows[0].lease_until).toBeNull()

      // The app id exists in that organization: its objects are not orphans.
      const recreated = await client.query<{ paths: string[] | null }>('SELECT public.delta_gc_begin_orphan_delete($1, $2::text[], 1000) AS paths', [own, [`${own}delta/x.js`]])
      expect(recreated.rows[0].paths).toBeNull()
      const gone = await client.query('SELECT 1 FROM public.delta_gc_orphan_prefixes WHERE prefix = $1', [own])
      expect(gone.rows).toEqual([])

      // A bundle zip still used by a kept version of this app id stays. A
      // transferred app keeps its zip in the former owner's prefix, which the
      // canonical-path guard rejects on insert, so it is bypassed here.
      const zip = `${orphan}1.0.0.zip`
      await client.query('SET LOCAL session_replication_role = replica')
      await client.query(
        `INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider, checksum, r2_path)
         VALUES ($1, $2, $3, $4, 'r2', 'c', $5)`,
        [APP_ID, `zip-${randomUUID().slice(0, 8)}`, ORG_ID, USER_ID, zip],
      )
      await client.query('SET LOCAL session_replication_role = origin')
      const zipBegin = await client.query<{ paths: string[] | null }>('SELECT public.delta_gc_begin_orphan_delete($1, $2::text[], 1000) AS paths', [orphan, [zip]])
      expect(zipBegin.rows[0].paths).toEqual([])

      // Recovery treats that zip as referenced too.
      await client.query(`INSERT INTO public.delta_gc_unsettled_deletes (path, app_id, recorded_at) VALUES ($1, $2, now() - interval '2 minutes')`, [zip, APP_ID])
      const zipRepair = await client.query<{ referenced: boolean }>('SELECT referenced FROM public.delta_gc_claim_unsettled(50) WHERE path = $1', [zip])
      expect(zipRepair.rows).toEqual([{ referenced: true }])

      // Moving the app id into an organization retires that organization's
      // task, but only once its delete lease has ended.
      await client.query(`INSERT INTO public.delta_gc_orphan_prefixes (prefix, app_id, org, lease_until) VALUES ($1, $2, $3, clock_timestamp() + interval '2 seconds')`, [own, APP_ID, ORG_ID])
      await client.query('UPDATE public.apps SET owner_org = owner_org WHERE app_id = $1', [APP_ID])
      const leased = await client.query('SELECT 1 FROM public.delta_gc_orphan_prefixes WHERE prefix = $1', [own])
      expect(leased.rows).toHaveLength(1)
      await client.query(`UPDATE public.delta_gc_orphan_prefixes SET lease_until = clock_timestamp() - interval '1 second' WHERE prefix = $1`, [own])
      await client.query('UPDATE public.apps SET owner_org = owner_org WHERE app_id = $1', [APP_ID])
      const retired = await client.query('SELECT 1 FROM public.delta_gc_orphan_prefixes WHERE prefix = $1', [own])
      expect(retired.rows).toEqual([])
    })
  })

  it('caps the delete lease at 2 seconds', async () => {
    await withConfig({ gc_enabled: true }, async (client) => {
      await readyForDeletes(client)
      await client.query('SELECT public.delta_gc_begin_delete($1, $2::text[], 60000)', [APP_ID, [deltaPath('cap.js')]])
      const lease = await client.query<{ ms: number }>('SELECT EXTRACT(EPOCH FROM lease_until - clock_timestamp()) * 1000 AS ms FROM public.delta_gc_state WHERE app_id = $1', [APP_ID])
      expect(Number(lease.rows[0].ms)).toBeLessThanOrEqual(2000)
      await client.query('SELECT public.delta_gc_end_delete($1)', [APP_ID])
      const ended = await client.query('SELECT lease_until FROM public.delta_gc_state WHERE app_id = $1', [APP_ID])
      expect(ended.rows[0].lease_until).toBeNull()
    })
  })
})

describe('delta storage v2 size lookups', () => {
  it('runs a mixed per-version and name-fallback size lookup on converted versions', async () => {
    const versionId = await insertVersion(pool)
    await insertLegacyRows(versionId, ['size.js'])
    const [{ name }] = (await pool.query<{ name: string }>('SELECT name FROM public.app_versions WHERE id = $1', [versionId])).rows

    const files = normalizeManifestSizeFiles([
      { file_name: 'size.js', file_hash: 'hash-size.js', download_url: `https://plugin.capgo.test/files/read/attachments/x/size.js?key=${versionId}` },
      { file_name: 'other.js', file_hash: 'hash-other.js', download_url: 'https://plugin.capgo.test/files/read/attachments/x/other.js?key=999999999' },
      { file_name: 'size.js', file_hash: 'hash-size.js' },
    ])
    const lookup = buildManifestSizeLookupQuery(APP_ID, name, undefined, files)
    expect(lookup?.text).toContain('UNION ALL')
    const result = await pool.query<{ file_hash: string, version_id: string, file_size: string }>(lookup!.text, lookup!.values)
    expect(result.rows.map(row => [row.file_hash, Number(row.version_id), Number(row.file_size)]))
      .toEqual([['hash-size.js', versionId, 10], ['hash-size.js', versionId, 10]])
  })
})
