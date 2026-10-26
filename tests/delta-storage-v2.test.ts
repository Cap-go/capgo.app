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
  legacy_manifest_writes: 'CAPGO_DELTA_STORAGE_LEGACY_MANIFEST_WRITES',
} as const

async function setSwitch(client: Pick<PoolClient, 'query'>, name: keyof typeof SWITCHES, value: boolean) {
  await client.query('DELETE FROM vault.secrets WHERE name = $1', [SWITCHES[name]])
  await client.query('SELECT vault.create_secret($1, $2)', [String(value), SWITCHES[name]])
}

// The Vault switches stay untouched for parallel test files: each case sets
// them inside its own transaction and rolls back.
async function withConfig<T>(settings: { gc_enabled?: boolean, legacy_manifest_writes?: boolean }, run: (client: PoolClient) => Promise<T>) {
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

beforeAll(async () => {
  await resetAndSeedAppData(APP_ID)
})

afterAll(async () => {
  await resetAppData(APP_ID)
  await pool.end()
})

describe('delta storage v2 conversion', () => {
  it('moves legacy rows into shared delta_files and one version_files row per version', async () => {
    const first = await insertVersion(pool)
    const second = await insertVersion(pool)
    await insertLegacyRows(first, ['a.js', 'b.js'])
    await insertLegacyRows(second, ['b.js', 'c.js'])

    for (const versionId of [first, second]) {
      const converted = await pool.query<{ removed: number }>('SELECT public.convert_version_manifest_rows($1) AS removed', [versionId])
      expect(converted.rows[0].removed).toBe(2)
    }

    expect(await versionFiles(first)).toEqual([deltaPath('a.js'), deltaPath('b.js')])
    expect(await versionFiles(second)).toEqual([deltaPath('b.js'), deltaPath('c.js')])
    const files = await pool.query('SELECT count(*)::int AS count FROM public.delta_files WHERE app_id = $1 AND s3_path = ANY($2::text[])', [APP_ID, [deltaPath('a.js'), deltaPath('b.js'), deltaPath('c.js')]])
    expect(files.rows[0].count).toBe(3)
    const legacy = await pool.query('SELECT count(*)::int AS count FROM public.manifest WHERE app_version_id = ANY($1::bigint[])', [[first, second]])
    expect(legacy.rows[0].count).toBe(0)

    const view = await pool.query('SELECT file_name FROM public.version_manifest WHERE app_version_id = $1 ORDER BY id', [second])
    expect(view.rows.map(row => row.file_name)).toEqual(['b.js', 'c.js'])
  })

  it('keeps legacy rows while legacy writes are on and converts after the switch', async () => {
    const versionId = await insertVersion(pool)
    await insertLegacyRows(versionId, ['batch.js'])

    await withConfig({ legacy_manifest_writes: true }, async (client) => {
      const result = await client.query('SELECT public.convert_legacy_manifest_batch(1000, 2000) AS converted')
      expect(result.rows[0].converted).toBe(0)
    })

    await withConfig({ legacy_manifest_writes: false }, async (client) => {
      await client.query('UPDATE public.delta_storage_state SET convert_cursor = $1 - 1 WHERE id', [versionId])
      const result = await client.query('SELECT public.convert_legacy_manifest_batch(1, 2000) AS converted')
      expect(result.rows[0].converted).toBe(1)
      const rows = await client.query('SELECT count(*)::int AS count FROM public.manifest WHERE app_version_id = $1', [versionId])
      expect(rows.rows[0].count).toBe(0)
      const kept = await client.query('SELECT cardinality(file_ids) AS count FROM public.version_files WHERE app_version_id = $1', [versionId])
      expect(kept.rows[0].count).toBe(1)
    })
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
    for (const versionId of [live, recent, old])
      await pool.query('SELECT public.convert_version_manifest_rows($1)', [versionId])

    const result = await pool.query<{ paths: string[] }>(
      'SELECT public.delta_gc_unreferenced_paths($1::text[]) AS paths',
      [[deltaPath('live.js'), deltaPath('recent.js'), deltaPath('old.js'), deltaPath('orphan.js')]],
    )
    expect(result.rows[0].paths.sort()).toEqual([deltaPath('old.js'), deltaPath('orphan.js')].sort())
  })

  it('never opens a delete lease while GC is disabled or an upload is in progress', async () => {
    const orphan = deltaPath('lease-orphan.js')
    const disabled = await pool.query<{ paths: string[] }>('SELECT public.delta_gc_begin_delete($1, $2::text[], 1000) AS paths', [APP_ID, [orphan]])
    expect(disabled.rows[0].paths).toEqual([])

    await withConfig({ gc_enabled: true }, async (client) => {
      await insertVersion(client, { storageProvider: 'r2-direct' })
      const blocked = await client.query<{ paths: string[] }>('SELECT public.delta_gc_begin_delete($1, $2::text[], 1000) AS paths', [APP_ID, [orphan]])
      expect(blocked.rows[0].paths).toEqual([])
    })

    await withConfig({ gc_enabled: true }, async (client) => {
      await client.query(`UPDATE public.app_versions SET storage_provider = 'r2' WHERE app_id = $1 AND storage_provider = 'r2-direct'`, [APP_ID])
      const allowed = await client.query<{ paths: string[] }>('SELECT public.delta_gc_begin_delete($1, $2::text[], 1000) AS paths', [APP_ID, [orphan]])
      expect(allowed.rows[0].paths).toEqual([orphan])
      const lease = await client.query('SELECT lease_until > clock_timestamp() AS active FROM public.delta_gc_state WHERE app_id = $1', [APP_ID])
      expect(lease.rows[0].active).toBe(true)
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
    await pool.query('SELECT public.convert_version_manifest_rows($1)', [versionId])

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

  it('does not postpone GC for apps whose only legacy rows are onboarding demo rows', async () => {
    const versionId = await insertVersion(pool)
    await pool.query(
      `INSERT INTO public.manifest (app_version_id, file_name, file_hash, s3_path, file_size) VALUES ($1, 'demo.js', 'demo', $2, 1)`,
      [versionId, `demo/${APP_ID}/demo.js`],
    )
    await withConfig({ gc_enabled: true }, async (client) => {
      // Convert this app's other legacy rows; demo versions are skipped by design.
      await client.query('SELECT public.convert_version_manifest_rows(id) FROM public.app_versions WHERE app_id = $1', [APP_ID])
      // Only this app is due inside the transaction.
      await client.query(`UPDATE public.delta_gc_state SET next_run_at = now() + interval '1 day'`)
      await client.query('UPDATE public.delta_gc_state SET next_run_at = now() - interval \'1 minute\' WHERE app_id = $1', [APP_ID])
      const claimed = await client.query<{ app_id: string }>('SELECT app_id FROM public.delta_gc_claim(5)')
      expect(claimed.rows.map(row => row.app_id)).toEqual([APP_ID])
    })
  })

  it('postpones GC for apps with a live inline jsonb manifest', async () => {
    await withConfig({ gc_enabled: true }, async (client) => {
      await client.query('SELECT public.convert_version_manifest_rows(id) FROM public.app_versions WHERE app_id = $1', [APP_ID])
      await client.query(
        `INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider, checksum, manifest)
         VALUES ($1, $2, $3, $4, 'r2', $5, ARRAY[ROW('inline.js', $6, 'hash')::public.manifest_entry])`,
        [APP_ID, `9.9.9-inline-${id.slice(0, 8)}`, ORG_ID, USER_ID, randomUUID().replaceAll('-', ''), deltaPath('inline.js')],
      )
      await client.query(`UPDATE public.delta_gc_state SET next_run_at = now() + interval '1 day'`)
      await client.query('UPDATE public.delta_gc_state SET next_run_at = now() - interval \'1 minute\' WHERE app_id = $1', [APP_ID])
      const claimed = await client.query('SELECT app_id FROM public.delta_gc_claim(5)')
      expect(claimed.rows).toEqual([])
    })
  })

  it('lists every former owner prefix of a transferred app in one pass', async () => {
    const formerOrg = '00000000-0000-4000-8000-0000000000aa'
    await withConfig({ gc_enabled: true }, async (client) => {
      await client.query('SELECT public.convert_version_manifest_rows(id) FROM public.app_versions WHERE app_id = $1', [APP_ID])
      await client.query(`DELETE FROM public.app_versions WHERE app_id = $1 AND manifest IS NOT NULL`, [APP_ID])
      await client.query(
        `INSERT INTO public.delta_files (app_id, s3_path, file_name, file_hash, path_key, entry_key)
         VALUES ($1, $2::text, 'old.js', 'h', public.delta_path_key($2::text), public.delta_entry_key($2::text, 'old.js', 'h'))`,
        [APP_ID, `orgs/${formerOrg}/apps/${APP_ID}/delta/old.js`],
      )
      await client.query(`UPDATE public.delta_gc_state SET next_run_at = now() + interval '1 day'`)
      await client.query(`UPDATE public.delta_gc_state SET next_run_at = now() - interval '1 minute', list_org = NULL, pending_orgs = NULL, list_cursor = NULL WHERE app_id = $1`, [APP_ID])

      const seen: string[] = []
      for (let pass = 0; pass < 3; pass++) {
        const claimed = await client.query<{ list_org: string }>('SELECT list_org FROM public.delta_gc_claim(5)')
        if (claimed.rows.length === 0)
          break
        seen.push(claimed.rows[0].list_org)
        await client.query('SELECT public.delta_gc_finish($1, NULL, NULL)', [APP_ID])
      }
      expect(seen).toEqual([formerOrg, ORG_ID].sort())
      const state = await client.query(`SELECT list_org, next_run_at > now() + interval '6 days' AS weekly FROM public.delta_gc_state WHERE app_id = $1`, [APP_ID])
      expect(state.rows[0]).toEqual({ list_org: null, weekly: true })
    })
  })

  it('caps the delete lease at 2 seconds', async () => {
    await withConfig({ gc_enabled: true }, async (client) => {
      await client.query(`UPDATE public.app_versions SET storage_provider = 'r2' WHERE app_id = $1 AND storage_provider = 'r2-direct'`, [APP_ID])
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
    await pool.query('SELECT public.convert_version_manifest_rows($1)', [versionId])
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
