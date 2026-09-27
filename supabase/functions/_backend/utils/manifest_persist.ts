import type { Context } from 'hono'
import { sql } from 'drizzle-orm'
import { cloudlog } from './logging.ts'
import { isPostgresSafeText, normalizeLegacyEncodedManifestFileName } from './manifest_encoding.ts'
import { closeClient, getDrizzleClient, getPgClient } from './pg.ts'
import { supabaseAdmin } from './supabase.ts'

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

  const pgPool = getPgClient(c, false)
  let alreadyPresent = false
  try {
    alreadyPresent = await getDrizzleClient(pgPool).transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_catalog.set_config('capgo.manifest_queue_managed', 'on', true)`)
      await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(${record.id})`)
      const existing = await tx.execute<{ id: number }>(sql`SELECT id FROM public.manifest WHERE app_version_id = ${record.id} LIMIT 1`)
      if (existing.rows.length > 0)
        return true

      const rowsJson = JSON.stringify(validEntries.map(({ file_name, s3_path, file_hash, file_size }) => ({ file_name, s3_path, file_hash, file_size })))
      await tx.execute(sql`INSERT INTO public.manifest (app_version_id, file_name, s3_path, file_hash, file_size)
        SELECT ${record.id}::bigint, entry.file_name, entry.s3_path, entry.file_hash, entry.file_size FROM jsonb_to_recordset(${rowsJson}::jsonb)
        AS entry(file_name text, s3_path text, file_hash text, file_size bigint)`)

      if (!options.trustFileSizes)
        await tx.execute(sql`WITH queued AS MATERIALIZED (SELECT pgmq.send('on_manifest_create', pg_catalog.jsonb_build_object(
          'function_name', 'on_manifest_create', 'function_type', 'cloudflare', 'payload', pg_catalog.jsonb_build_object('old_record', NULL,
          'record', pg_catalog.to_jsonb(manifest), 'type', 'INSERT', 'table', 'manifest', 'schema', 'public'))) AS msg_id
          FROM public.manifest WHERE app_version_id = ${record.id}) SELECT count(*) FROM queued`)

      await tx.execute(sql`UPDATE public.app_versions SET manifest_count = ${validEntries.length}, updated_at = now()
        ${sql.raw(options.clearAppVersionsManifest ? ', manifest = NULL' : '')} WHERE id = ${record.id}`)
      await tx.execute(sql`UPDATE public.apps SET manifest_bundle_count = manifest_bundle_count + 1, updated_at = now() WHERE app_id = ${record.app_id}`)
      return false
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
