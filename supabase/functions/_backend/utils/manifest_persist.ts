import type { Context } from 'hono'
import { cloudlog } from './logging.ts'
import { normalizeLegacyEncodedManifestFileName } from './manifest_encoding.ts'
import { closeClient, getPgClient } from './pg.ts'
import { supabaseAdmin } from './supabase.ts'

export interface ManifestPersistEntry {
  file_name?: string | null
  file_hash?: string | null
  s3_path?: string | null
  // Intentionally ignored — file sizes are set by on_manifest_create from R2.
  file_size?: number | null
}

export interface PersistVersionManifestResult {
  inserted: number
  alreadyPresent: boolean
}

export function buildTrustedManifestRows(
  appVersionId: number,
  entries: ManifestPersistEntry[],
  s3PathPrefix?: string | null,
) {
  return entries
    .filter(entry => entry.file_name && entry.file_hash && entry.s3_path)
    .filter(entry => !s3PathPrefix || entry.s3_path!.startsWith(s3PathPrefix))
    .map(entry => ({
      app_version_id: appVersionId,
      file_name: normalizeLegacyEncodedManifestFileName(entry.file_name, entry.s3_path)!,
      file_hash: entry.file_hash!,
      s3_path: entry.s3_path!,
      // Never trust client-provided sizes; on_manifest_create fills these from R2.
      file_size: 0,
    }))
}

async function clearLegacyAppVersionManifest(c: Context, versionId: number) {
  const { error: deleteError } = await supabaseAdmin(c)
    .from('app_versions')
    .update({ manifest: null })
    .eq('id', versionId)
  if (deleteError)
    cloudlog({ requestId: c.get('requestId'), message: 'error delete manifest in app_versions', error: deleteError })
}

/**
 * Inserts manifest rows for a version when none exist yet.
 * Always writes file_size=0; trusted sizes come from on_manifest_create via R2 HEAD.
 */
export async function persistVersionManifestEntries(
  c: Context,
  record: { id: number, app_id: string },
  manifestEntries: ManifestPersistEntry[],
  options: {
    clearAppVersionsManifest?: boolean
    s3PathPrefix?: string | null
  } = {},
): Promise<PersistVersionManifestResult> {
  if (!Array.isArray(manifestEntries))
    return { inserted: 0, alreadyPresent: false }

  const validEntries = buildTrustedManifestRows(record.id, manifestEntries, options.s3PathPrefix)
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

  const pgPool = getPgClient(c, false)
  const pgClient = await pgPool.connect()
  try {
    await pgClient.query('BEGIN')
    // Serialize concurrent writers for this version (no unique constraint on manifest rows).
    await pgClient.query('SELECT pg_advisory_xact_lock($1)', [record.id])

    const existing = await pgClient.query<{ id: number }>(
      'SELECT id FROM public.manifest WHERE app_version_id = $1 LIMIT 1',
      [record.id],
    )
    if (existing.rows.length > 0) {
      await pgClient.query('COMMIT')
      if (options.clearAppVersionsManifest)
        await clearLegacyAppVersionManifest(c, record.id)
      return { inserted: 0, alreadyPresent: true }
    }

    await pgClient.query(
      `INSERT INTO public.manifest (app_version_id, file_name, s3_path, file_hash, file_size)
       SELECT
         $1::bigint,
         entry.file_name,
         entry.s3_path,
         entry.file_hash,
         0
       FROM jsonb_to_recordset($2::jsonb) AS entry(
         file_name text,
         s3_path text,
         file_hash text
       )`,
      [record.id, JSON.stringify(validEntries.map(({ file_name, s3_path, file_hash }) => ({ file_name, s3_path, file_hash })))],
    )

    await pgClient.query(
      `UPDATE public.app_versions
       SET manifest_count = $2,
           updated_at = now()
           ${options.clearAppVersionsManifest ? ', manifest = NULL' : ''}
       WHERE id = $1`,
      [record.id, validEntries.length],
    )

    await pgClient.query(
      `UPDATE public.apps
       SET manifest_bundle_count = manifest_bundle_count + 1,
           updated_at = now()
       WHERE app_id = $1`,
      [record.app_id],
    )

    await pgClient.query('COMMIT')
  }
  catch (error) {
    try {
      await pgClient.query('ROLLBACK')
    }
    catch (rollbackError) {
      cloudlog({ requestId: c.get('requestId'), message: 'error rollback manifest persist', error: rollbackError, id: record.id })
    }
    cloudlog({ requestId: c.get('requestId'), message: 'error insert manifest', error, id: record.id })
    throw error
  }
  finally {
    pgClient.release()
    await closeClient(c, pgPool)
  }

  return { inserted: validEntries.length, alreadyPresent: false }
}
