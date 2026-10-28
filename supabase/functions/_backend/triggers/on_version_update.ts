import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { PgClient } from '../utils/pg.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { isVersionDeleted, purgeFileReadCache } from '../files/file_read_cache.ts'
import { isCanonicalAppVersionR2Path } from '../utils/app_version_r2_path.ts'
import { BRES, middlewareAPISecret, simpleError, triggerValidator } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { deleteVersionManifestBatch } from '../utils/manifest_cleanup.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'
import { queryJsonOne } from '../utils/pg_rls.ts'
import { getPath, s3 } from '../utils/s3.ts'
import { createStatsMeta } from '../utils/stats.ts'

/**
 * Resolves `owner_org` for an app version row.
 *
 * Falls back to the owning app when the trigger payload does not include it.
 */
async function resolveOwnerOrg(c: Context, pg: PgClient, record: Database['public']['Tables']['app_versions']['Row']): Promise<string | null> {
  if (record.owner_org)
    return record.owner_org
  if (!record.app_id)
    return null

  try {
    const { rows } = await pg.query<{ owner_org: string }>('SELECT owner_org FROM public.apps WHERE app_id = $1', [record.app_id])
    return rows[0]?.owner_org ?? null
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'error resolveOwnerOrg', error, app_id: record.app_id })
    return null
  }
}

function upsertVersionMeta(pg: PgClient, record: Database['public']['Tables']['app_versions']['Row'], ownerOrg: string, size: number) {
  return pg.query(
    `INSERT INTO public.app_versions_meta (id, app_id, owner_org, size, checksum)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (id) DO UPDATE SET
      app_id = EXCLUDED.app_id,
      owner_org = EXCLUDED.owner_org,
      size = EXCLUDED.size,
      checksum = EXCLUDED.checksum`,
    [record.id, record.app_id, ownerOrg, size, record.checksum ?? ''],
  )
}

function getManifestEntryCount(value: unknown): number {
  if (Array.isArray(value))
    return value.length
  return value ? 1 : 0
}

function versionUpdateLogFields(
  record: Database['public']['Tables']['app_versions']['Row'],
  oldRecord?: Database['public']['Tables']['app_versions']['Row'] | null,
) {
  return {
    app_id: record.app_id,
    deleted_at: record.deleted_at,
    id: record.id,
    manifest_count: record.manifest_count,
    manifest_entries: getManifestEntryCount(record.manifest),
    old_deleted_at: oldRecord?.deleted_at ?? null,
    old_r2_path: oldRecord?.r2_path ?? null,
    old_storage_provider: oldRecord?.storage_provider ?? null,
    old_updated_at: oldRecord?.updated_at ?? null,
    r2_path: record.r2_path,
    storage_provider: record.storage_provider,
    updated_at: record.updated_at,
    version_name: record.name,
  }
}

type DeletedVersionAction = 'continue' | 'delete' | 'cleanup_manifest'

async function unlinkChannelsFromDeletedVersion(
  c: Context,
  pg: PgClient,
  record: Database['public']['Tables']['app_versions']['Row'],
) {
  if (!record.app_id)
    return

  try {
    await pg.query(
      'UPDATE public.channels SET version = NULL, updated_at = $1 WHERE app_id = $2 AND version = $3',
      [new Date().toISOString(), record.app_id, record.id],
    )
  }
  catch (error) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'error unlinking channels.version for deleted bundle',
      error,
      id: record.id,
      app_id: record.app_id,
    })
    throw simpleError('cannot_unlink_deleted_channel_version', 'Cannot unlink channels from deleted bundle', { id: record.id }, error)
  }

  try {
    await pg.query(
      'UPDATE public.channels SET rollout_version = NULL, updated_at = $1 WHERE app_id = $2 AND rollout_version = $3',
      [new Date().toISOString(), record.app_id, record.id],
    )
  }
  catch (rolloutError) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'error unlinking channels.rollout_version for deleted bundle',
      error: rolloutError,
      id: record.id,
      app_id: record.app_id,
    })
    throw simpleError('cannot_unlink_deleted_channel_rollout_version', 'Cannot unlink channel rollout from deleted bundle', { id: record.id }, rolloutError)
  }
}

function getDeletedVersionAction(
  record: Database['public']['Tables']['app_versions']['Row'],
  oldRecord?: Database['public']['Tables']['app_versions']['Row'] | null,
): DeletedVersionAction {
  if (!isVersionDeleted(record))
    return 'continue'

  const deletionStateChanged = record.deleted !== oldRecord?.deleted
    || record.deleted_at !== oldRecord?.deleted_at
  if (deletionStateChanged)
    return 'delete'
  // Counts alone cannot reveal legacy manifest rows.
  return 'cleanup_manifest'
}

function getMetadataBranch(storageProvider: string | null, resolvedR2Path: string | null) {
  if (storageProvider === 'r2' && resolvedR2Path)
    return 'r2_bundle_size'
  if (storageProvider === 'r2')
    return 'zero_metadata_r2_path_unavailable'
  if (storageProvider === 'r2-direct')
    return 'zero_metadata_r2_direct_not_finalized'
  return 'zero_metadata_non_r2_storage'
}

/**
 * Handles v2 storage metadata updates (size/checksum/stats) for R2-backed bundles.
 *
 * Returns `false` only when processing must stop (e.g. missing owner org).
 */
async function v2PathSize(c: Context, pg: PgClient, record: Database['public']['Tables']['app_versions']['Row'], v2Path: string): Promise<boolean> {
  cloudlog({
    requestId: c.get('requestId'),
    message: 'on_version_update reading bundle size',
    ...versionUpdateLogFields(record),
    resolved_r2_path: v2Path,
  })

  const diagnostics = await s3.getSizeDiagnostics(c, v2Path)
  const size = diagnostics.size
  if (!size) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'no size found for r2_path',
      ...versionUpdateLogFields(record),
      resolved_r2_path: v2Path,
      size,
      storageDiagnostics: diagnostics,
    })
    return true
  }

  cloudlog({
    requestId: c.get('requestId'),
    message: 'on_version_update resolved bundle size',
    ...versionUpdateLogFields(record),
    resolved_r2_path: v2Path,
    selectedCandidateKey: diagnostics.selectedCandidateKey,
    size,
  })

  const ownerOrg = await resolveOwnerOrg(c, pg, record)
  if (!ownerOrg) {
    cloudlog({ requestId: c.get('requestId'), message: 'missing owner_org for app_versions_meta upsert', id: record.id, app_id: record.app_id })
    return false
  }

  // allow to update even without checksum, to prevent bad actor to remove checksum to get free storage
  try {
    await upsertVersionMeta(pg, record, ownerOrg, size)
    cloudlog({ requestId: c.get('requestId'), message: 'app_versions_meta size upserted', ...versionUpdateLogFields(record), owner_org: ownerOrg, size })
  }
  catch (errorUpdate) {
    cloudlog({ requestId: c.get('requestId'), message: 'errorUpdate', error: errorUpdate, ...versionUpdateLogFields(record), size })
  }
  const { error } = await createStatsMeta(c, record.app_id, record.id, size)
  if (error)
    cloudlog({ requestId: c.get('requestId'), message: 'error createStatsMeta', error })
  return true
}

/**
 * Reloads `app_versions.manifest` when the queue payload omitted it to stay under size limits.
 */
async function ensureVersionManifest(
  c: Context,
  record: Database['public']['Tables']['app_versions']['Row'],
): Promise<Database['public']['Tables']['app_versions']['Row']> {
  if (record.manifest)
    return record

  type ManifestRow = Pick<Database['public']['Tables']['app_versions']['Row'], 'manifest'>
  let data: ManifestRow | null
  const pg = await getPgClient(c)
  try {
    data = await queryJsonOne<ManifestRow>(pg, 'SELECT manifest FROM public.app_versions WHERE id = $1', [record.id])
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'error reload app_versions.manifest', error, id: record.id })
    throw simpleError('manifest_reload_failed', 'Failed to reload app_versions.manifest', { id: record.id }, error)
  }
  finally {
    closeClient(c, pg)
  }

  if (!data?.manifest)
    return record

  cloudlog({
    requestId: c.get('requestId'),
    message: 'on_version_update reloaded manifest from database',
    id: record.id,
    manifest_entries: getManifestEntryCount(data.manifest),
  })
  return { ...record, manifest: data.manifest }
}

/**
 * Handles app version metadata updates after insert/update trigger execution.
 */
async function updateIt(c: Context, record: Database['public']['Tables']['app_versions']['Row']) {
  const pg = await getPgClient(c)
  try {
    return await updateItWithClient(c, pg, record)
  }
  finally {
    closeClient(c, pg)
  }
}

async function updateItWithClient(c: Context, pg: PgClient, record: Database['public']['Tables']['app_versions']['Row']) {
  const v2Path = await getPath(c, record)
  const metadataBranch = getMetadataBranch(record.storage_provider, v2Path)
  cloudlog({
    requestId: c.get('requestId'),
    message: 'on_version_update metadata branch selected',
    ...versionUpdateLogFields(record),
    metadataBranch,
    resolved_r2_path: v2Path,
  })

  if (metadataBranch === 'r2_bundle_size' && v2Path) {
    const shouldContinue = await v2PathSize(c, pg, record, v2Path)
    if (!shouldContinue)
      return c.json(BRES)
  }
  else {
    cloudlog({ requestId: c.get('requestId'), message: 'on_version_update zero metadata branch selected', ...versionUpdateLogFields(record), metadataBranch, resolved_r2_path: v2Path })
    const ownerOrg = await resolveOwnerOrg(c, pg, record)
    if (!ownerOrg) {
      cloudlog({ requestId: c.get('requestId'), message: 'missing owner_org for app_versions_meta upsert', id: record.id, app_id: record.app_id })
      return c.json(BRES)
    }
    try {
      await upsertVersionMeta(pg, record, ownerOrg, 0)
      cloudlog({ requestId: c.get('requestId'), message: 'app_versions_meta zero size upserted', ...versionUpdateLogFields(record), metadataBranch, owner_org: ownerOrg, size: 0 })
    }
    catch (errorUpdate) {
      cloudlog({ requestId: c.get('requestId'), message: 'errorUpdate', error: errorUpdate, ...versionUpdateLogFields(record), metadataBranch, size: 0 })
    }
  }

  return c.json(BRES)
}

/**
 * Finalize the deleted version's manifest counters in one short transaction.
 * Its version_files row and the delta bytes in R2 stay; delta storage GC
 * reclaims them once no version kept for the 7-day restore window references
 * them.
 */
async function deleteManifest(c: Context, record: Database['public']['Tables']['app_versions']['Row'], pg?: PgClient) {
  if (pg) {
    await deleteVersionManifestBatch(getDrizzleClient(pg), record.id)
    return
  }
  const pool = await getPgClient(c, false)
  try {
    await deleteVersionManifestBatch(getDrizzleClient(pool), record.id)
  }
  finally {
    await closeClient(c, pool)
  }
}

async function deleteVersionDatabaseState(c: Context, pg: PgClient, record: Database['public']['Tables']['app_versions']['Row']) {
  await unlinkChannelsFromDeletedVersion(c, pg, record)

  if (record.r2_path) {
    try {
      await purgeFileReadCache(record.r2_path, record.checksum)
    }
    catch (error) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'purgeFileReadCache failed during version delete',
        r2_path: record.r2_path,
        error,
      })
    }
  }

  // Release only manifest database references before ACK; delta objects stay in R2.
  await deleteManifest(c, record, pg)

  let data: { size: number } | null
  try {
    data = await queryJsonOne<{ size: number }>(pg, 'SELECT size FROM public.app_versions_meta WHERE id = $1', [record.id])
  }
  catch {
    data = null
  }
  if (!data) {
    cloudlog({ requestId: c.get('requestId'), message: 'Cannot find version meta', id: record.id })
  }
  else {
    const { error: errorCreateStatsMeta } = await createStatsMeta(c, record.app_id, record.id, -data.size)
    if (errorCreateStatsMeta)
      cloudlog({ requestId: c.get('requestId'), message: 'error createStatsMeta', error: errorCreateStatsMeta })

    try {
      await pg.query('UPDATE public.app_versions_meta SET size = 0 WHERE id = $1', [record.id])
    }
    catch (errorUpdate) {
      cloudlog({ requestId: c.get('requestId'), message: 'error', error: errorUpdate })
      throw simpleError('cannot_update_version_meta', 'Cannot update version metadata for deleted version', { id: record.id }, errorUpdate)
    }
  }
}

export async function deleteIt(c: Context, record: Database['public']['Tables']['app_versions']['Row']) {
  cloudlog({ requestId: c.get('requestId'), message: 'Delete', r2_path: record.r2_path })

  const pg = await getPgClient(c, false)
  try {
    await deleteVersionDatabaseState(c, pg, record)
  }
  finally {
    await closeClient(c, pg)
  }

  // Bundle zip: move to lifecycle trash. Retry via queue if this fails; manifests already cleared.
  if (record.r2_path) {
    if (!isCanonicalAppVersionR2Path(record)) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'Skipping bundle trash for non-canonical r2_path',
        id: record.id,
        app_id: record.app_id,
        owner_org: record.owner_org,
        name: record.name,
        r2_path: record.r2_path,
      })
    }
    else {
      let moved = false
      try {
        moved = await s3.moveObjectToTrash(c, record.r2_path)
      }
      catch (error) {
        cloudlog({ requestId: c.get('requestId'), message: 'Cannot move s3 to trash (v2)', error })
        throw simpleError('cannot_move_s3_to_trash', 'Cannot move S3 object for deleted version to trash', { id: record.id, r2_path: record.r2_path }, error)
      }

      if (!moved) {
        throw simpleError('cannot_move_s3_to_trash', 'Cannot move S3 object for deleted version to trash', { id: record.id, r2_path: record.r2_path })
      }
    }
  }
  else {
    cloudlog({ requestId: c.get('requestId'), message: 'No r2 path for deleted version', id: record.id })
  }

  return c.json(BRES)
}

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, triggerValidator('app_versions', 'UPDATE'), async (c) => {
  const record = c.get('webhookBody') as Database['public']['Tables']['app_versions']['Row']
  const oldRecord = c.get('oldRecord') as Database['public']['Tables']['app_versions']['Row']
  cloudlog({ requestId: c.get('requestId'), message: 'on_version_update received', ...versionUpdateLogFields(record, oldRecord) })
  cloudlog({ requestId: c.get('requestId'), message: 'record', record })

  if (!record.app_id) {
    cloudlog({ requestId: c.get('requestId'), message: 'no app_id', record })
    return c.json(BRES)
  }
  // Queue payloads omit app_versions.manifest; reload before deleted-version decisions.
  let workRecord = record
  if (!workRecord.manifest)
    workRecord = await ensureVersionManifest(c, workRecord)

  const deletedVersionAction = getDeletedVersionAction(workRecord, oldRecord)
  if (deletedVersionAction === 'delete')
    return deleteIt(c, workRecord)
  if (deletedVersionAction === 'cleanup_manifest') {
    cloudlog({ requestId: c.get('requestId'), message: 'retrying cleanup for already deleted version', ...versionUpdateLogFields(workRecord, oldRecord) })
    // Sweeper retries must also finish metadata/ZIP work after the last batch.
    return deleteIt(c, workRecord)
  }

  if (!workRecord.r2_path && !workRecord.manifest) {
    cloudlog({ requestId: c.get('requestId'), message: 'no r2_path and no manifest, skipping update', ...versionUpdateLogFields(workRecord, oldRecord) })
    return c.json(BRES)
  }

  cloudlog({ requestId: c.get('requestId'), message: 'Update but not deleted', ...versionUpdateLogFields(workRecord, oldRecord) })
  return updateIt(c, workRecord)
})

export const onVersionUpdateTestUtils = {
  getDeletedVersionAction,
  deleteManifest,
  unlinkChannelsFromDeletedVersion,
}
