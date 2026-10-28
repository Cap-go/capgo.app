import type { Context } from 'hono'
import { sql } from 'drizzle-orm'
import { cloudlog } from './logging.ts'
import { isPostgresSafeText, normalizeLegacyEncodedManifestFileName } from './manifest_encoding.ts'
import { closeClient, getDrizzleClient, getPgClient } from './pg.ts'

export interface ManifestPersistEntry {
  file_name?: string | null
  file_hash?: string | null
  s3_path?: string | null
  // Used only after server-side receipt verification.
  file_size?: number | null
  file_size_receipt?: string | null
}

export interface PersistVersionManifestResult {
  inserted: number
  alreadyPresent: boolean
}

export function buildTrustedManifestRows(
  appVersionId: number,
  entries: ManifestPersistEntry[],
  s3PathPrefix?: string | null,
  trustFileSizes = false,
) {
  return entries
    .filter(entry => entry.file_name && entry.file_hash && entry.s3_path)
    .filter(entry => !s3PathPrefix || entry.s3_path!.startsWith(s3PathPrefix))
    .map(entry => ({
      app_version_id: appVersionId,
      file_name: normalizeLegacyEncodedManifestFileName(entry.file_name, entry.s3_path)!,
      file_hash: entry.file_hash!,
      s3_path: entry.s3_path!,
      file_size: trustFileSizes ? entry.file_size! : 0,
    }))
    // Drop rows that would raise Postgres 54000 "null character not permitted".
    .filter(entry =>
      isPostgresSafeText(entry.file_name)
      && isPostgresSafeText(entry.file_hash)
      && isPostgresSafeText(entry.s3_path),
    )
}

type PersistTransaction = Parameters<Parameters<ReturnType<typeof getDrizzleClient>['transaction']>[0]>[0]

/**
 * Writes one version's entries: unique files go to delta_files (deduplicated
 * across versions), the ordered id list to version_files.
 */
async function persistDeltaStorageRows(
  tx: PersistTransaction,
  record: { id: number, app_id: string },
  rowsJson: string,
  trustFileSizes: boolean,
) {
  // Unique by entry key; the largest trusted size wins inside one request.
  await tx.execute(sql`
    INSERT INTO public.delta_files AS df (app_id, s3_path, file_name, file_hash, file_size, path_key, entry_key)
    SELECT DISTINCT ON (keyed.entry_key)
      ${record.app_id}, keyed.s3_path, keyed.file_name, keyed.file_hash, keyed.file_size, keyed.path_key, keyed.entry_key
    FROM (
      SELECT entry.s3_path, entry.file_name, entry.file_hash, COALESCE(entry.file_size, 0) AS file_size,
        public.delta_path_key(entry.s3_path) AS path_key,
        public.delta_entry_key(entry.s3_path, entry.file_name, entry.file_hash) AS entry_key
      FROM jsonb_to_recordset(${rowsJson}::jsonb) AS entry(file_name text, s3_path text, file_hash text, file_size bigint)
    ) AS keyed
    ORDER BY keyed.entry_key, keyed.file_size DESC
    ON CONFLICT (entry_key) DO UPDATE SET file_size = EXCLUDED.file_size
    WHERE df.file_size = 0 AND EXCLUDED.file_size > 0
  `)
  await tx.execute(sql`
    INSERT INTO public.version_files (app_version_id, file_ids)
    SELECT ${record.id}::bigint, pg_catalog.array_agg(df.id ORDER BY entry.ord)
    FROM pg_catalog.jsonb_array_elements(${rowsJson}::jsonb) WITH ORDINALITY AS entry(value, ord)
    INNER JOIN public.delta_files AS df
      ON df.entry_key = public.delta_entry_key(entry.value->>'s3_path', entry.value->>'file_name', entry.value->>'file_hash')
  `)

  if (!trustFileSizes) {
    // Without receipts, sizes come from one R2 lookup per new unsized file.
    await tx.execute(sql`WITH queued AS MATERIALIZED (SELECT pgmq.send('on_manifest_create', pg_catalog.jsonb_build_object(
      'function_name', 'on_manifest_create', 'function_type', 'cloudflare', 'payload', pg_catalog.jsonb_build_object('old_record', NULL,
      'record', pg_catalog.to_jsonb(df), 'type', 'INSERT', 'table', 'delta_files', 'schema', 'public'))) AS msg_id
      FROM public.delta_files AS df
      WHERE df.file_size = 0
        AND df.id IN (SELECT pg_catalog.unnest(file_ids) FROM public.version_files WHERE app_version_id = ${record.id}))
      SELECT count(*) FROM queued`)
  }
}

async function clearLegacyAppVersionManifest(c: Context, versionId: number) {
  try {
    const pg = await getPgClient(c)
    try {
      await pg.query('UPDATE public.app_versions SET manifest = NULL WHERE id = $1', [versionId])
    }
    finally {
      closeClient(c, pg)
    }
  }
  catch (deleteError) {
    cloudlog({ requestId: c.get('requestId'), message: 'error delete manifest in app_versions', error: deleteError })
  }
}

/**
 * Inserts manifest rows for a version when none exist yet.
 * Writes receipt-verified sizes directly; legacy callers are queued for R2 lookup.
 */
export async function persistVersionManifestEntries(
  c: Context,
  record: { id: number, app_id: string },
  manifestEntries: ManifestPersistEntry[],
  options: {
    clearAppVersionsManifest?: boolean
    s3PathPrefix?: string | null
    trustFileSizes?: boolean
  } = {},
): Promise<PersistVersionManifestResult> {
  if (!Array.isArray(manifestEntries))
    return { inserted: 0, alreadyPresent: false }

  const validEntries = buildTrustedManifestRows(record.id, manifestEntries, options.s3PathPrefix, options.trustFileSizes)
  const dropped = manifestEntries.length - validEntries.length
  if (dropped > 0) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'manifest persist dropped invalid entries',
      id: record.id,
      dropped,
      total: manifestEntries.length,
      kept: validEntries.length,
    })
  }

  if (validEntries.length === 0) {
    if (options.clearAppVersionsManifest)
      await clearLegacyAppVersionManifest(c, record.id)
    return { inserted: 0, alreadyPresent: false }
  }

  const pgPool = await getPgClient(c, false)
  let alreadyPresent = false
  try {
    alreadyPresent = await getDrizzleClient(pgPool).transaction(async (tx) => {
      // Shared side of the per-app delta GC lock: GC cannot decide to delete
      // while references are added, and sees this version as in progress.
      await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtext('delta_gc'), public.delta_gc_lock_key(${record.app_id}))`)
      await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(${record.id})`)
      // upload_in_progress mirrors delta_app_has_upload_in_progress (GC's view).
      const version = await tx.execute<{ deleted: boolean, deleted_at: string | null, storage_provider: string, upload_in_progress: boolean }>(sql`
        SELECT deleted, deleted_at, storage_provider,
          GREATEST(created_at, updated_at) > now() - interval '1 day' AS upload_in_progress
        FROM public.app_versions WHERE id = ${record.id} FOR UPDATE
      `)
      // An upload may have passed its route check before deletion started.
      // Serialize with cleanup and recheck before inserting any references.
      if (!version.rows[0] || version.rows[0].deleted || version.rows[0].deleted_at)
        throw new Error('Deleted versions cannot receive manifest entries')
      const existing = await tx.execute<{ present: boolean }>(sql`
        SELECT EXISTS (SELECT 1 FROM public.version_files WHERE app_version_id = ${record.id}) AS present
      `)
      const alreadyPresent = existing.rows[0]?.present === true
      // New references are only added while GC treats the upload as in progress.
      if (!alreadyPresent && (version.rows[0].storage_provider !== 'r2-direct' || version.rows[0].upload_in_progress !== true))
        throw new Error('Only in-progress uploads can receive manifest entries')

      if (!alreadyPresent) {
        const rowsJson = JSON.stringify(validEntries.map(({ file_name, s3_path, file_hash, file_size }) => ({ file_name, s3_path, file_hash, file_size })))
        await persistDeltaStorageRows(tx, record, rowsJson, options.trustFileSizes === true)

        await tx.execute(sql`UPDATE public.app_versions SET manifest_count = ${validEntries.length}, updated_at = now()
          ${sql.raw(options.clearAppVersionsManifest ? ', manifest = NULL' : '')} WHERE id = ${record.id}`)
        await tx.execute(sql`UPDATE public.apps SET manifest_bundle_count = manifest_bundle_count + 1, updated_at = now() WHERE app_id = ${record.app_id}`)
      }

      return alreadyPresent
    })
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'error insert manifest', error, id: record.id })
    throw error
  }
  finally {
    await closeClient(c, pgPool)
  }

  if (alreadyPresent) {
    if (options.clearAppVersionsManifest)
      await clearLegacyAppVersionManifest(c, record.id)
    return { inserted: 0, alreadyPresent: true }
  }

  return { inserted: validEntries.length, alreadyPresent: false }
}
