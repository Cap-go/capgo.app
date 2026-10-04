import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono/tiny'
import { isVersionDeleted, purgeFileReadCache } from '../files/file_read_cache.ts'
import { isCanonicalAppVersionR2Path } from '../utils/app_version_r2_path.ts'
import { BRES, middlewareAPISecret, simpleError, triggerValidator } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { persistVersionManifestEntries } from '../utils/manifest_persist.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'
import { getPath, s3 } from '../utils/s3.ts'
import { createStatsMeta } from '../utils/stats.ts'
import { supabaseAdmin } from '../utils/supabase.ts'
import { sendEventToTracking } from '../utils/tracking.ts'
import { enqueueManifestCleanup } from './manifest_cleanup_queue.ts'

/**
 * Resolves `owner_org` for an app version row.
 *
 * Falls back to the owning app when the trigger payload does not include it.
 */
async function resolveOwnerOrg(c: Context, record: Database['public']['Tables']['app_versions']['Row']): Promise<string | null> {
  if (record.owner_org)
    return record.owner_org
  if (!record.app_id)
    return null

  const { data, error } = await supabaseAdmin(c)
    .from('apps')
    .select('owner_org')
    .eq('app_id', record.app_id)
    .maybeSingle()

  if (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'error resolveOwnerOrg', error, app_id: record.app_id })
    return null
  }

  return data?.owner_org ?? null
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

type DeletedVersionAction = 'continue' | 'delete' | 'cleanup_manifest' | 'skip'

async function unlinkChannelsFromDeletedVersion(
  c: Context,
  record: Database['public']['Tables']['app_versions']['Row'],
) {
  if (!record.app_id)
    return

  const { error } = await supabaseAdmin(c)
    .from('channels')
    .update({
      version: null,
      updated_at: new Date().toISOString(),
    })
    .eq('app_id', record.app_id)
    .eq('version', record.id)

  if (error) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'error unlinking channels.version for deleted bundle',
      error,
      id: record.id,
      app_id: record.app_id,
    })
    throw simpleError('cannot_unlink_deleted_channel_version', 'Cannot unlink channels from deleted bundle', { id: record.id }, error)
  }

  const { error: rolloutError } = await supabaseAdmin(c)
    .from('channels')
    .update({
      rollout_version: null,
      updated_at: new Date().toISOString(),
    })
    .eq('app_id', record.app_id)
    .eq('rollout_version', record.id)

  if (rolloutError) {
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
  if (record.manifest || (record.manifest_count ?? 0) > 0)
    return 'cleanup_manifest'
  return 'skip'
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
async function v2PathSize(c: Context, record: Database['public']['Tables']['app_versions']['Row'], v2Path: string): Promise<boolean> {
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

  const ownerOrg = await resolveOwnerOrg(c, record)
  if (!ownerOrg) {
    cloudlog({ requestId: c.get('requestId'), message: 'missing owner_org for app_versions_meta upsert', id: record.id, app_id: record.app_id })
    return false
  }

  // allow to update even without checksum, to prevent bad actor to remove checksum to get free storage
  const { error: errorUpdate } = await supabaseAdmin(c)
    .from('app_versions_meta')
    .upsert({
      id: record.id,
      app_id: record.app_id,
      owner_org: ownerOrg,
      size,
      checksum: record.checksum ?? '',
    }, {
      onConflict: 'id',
    })
    .eq('id', record.id)
  if (errorUpdate) {
    cloudlog({ requestId: c.get('requestId'), message: 'errorUpdate', error: errorUpdate, ...versionUpdateLogFields(record), size })
  }
  else {
    cloudlog({ requestId: c.get('requestId'), message: 'app_versions_meta size upserted', ...versionUpdateLogFields(record), owner_org: ownerOrg, size })
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

  const { data, error } = await supabaseAdmin(c)
    .from('app_versions')
    .select('manifest')
    .eq('id', record.id)
    .maybeSingle()

  if (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'error reload app_versions.manifest', error, id: record.id })
    throw simpleError('manifest_reload_failed', 'Failed to reload app_versions.manifest', { id: record.id }, error)
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
 * Legacy path: CLI wrote jsonb onto app_versions.manifest; migrate into public.manifest.
 * New CLIs call /private/set_manifest directly and skip this jsonb hop.
 */
async function handleManifest(c: Context, record: Database['public']['Tables']['app_versions']['Row']) {
  cloudlog({ requestId: c.get('requestId'), message: 'manifest', manifest: record.manifest })
  const manifestEntries = record.manifest as Database['public']['CompositeTypes']['manifest_entry'][]
  if (!Array.isArray(manifestEntries))
    return

  const ownerOrg = await resolveOwnerOrg(c, record)
  const s3PathPrefix = ownerOrg && record.app_id
    ? `orgs/${ownerOrg}/apps/${record.app_id}/`
    : null

  const { inserted, alreadyPresent } = await persistVersionManifestEntries(
    c,
    { id: record.id, app_id: record.app_id },
    manifestEntries,
    { clearAppVersionsManifest: true, s3PathPrefix },
  )

  if (alreadyPresent || inserted === 0)
    return

  await sendEventToTracking(c, {
    channel: 'bundle',
    event: 'Legacy Bundle Manifest Migrated',
    user_id: record.user_id ?? undefined,
    ...(ownerOrg ? { groups: { organization: ownerOrg } } : {}),
    nonPersonTags: {
      $insert_id: `legacy-manifest:${record.id}`,
      app_id: record.app_id,
      cli_version: record.cli_version ?? 'unknown',
      entry_count: inserted,
      version_id: record.id,
    },
  })
}

/**
 * Handles app version metadata updates after insert/update trigger execution.
 */
async function updateIt(c: Context, record: Database['public']['Tables']['app_versions']['Row']) {
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
    const shouldContinue = await v2PathSize(c, record, v2Path)
    if (!shouldContinue)
      return c.json(BRES)
  }
  else {
    cloudlog({ requestId: c.get('requestId'), message: 'on_version_update zero metadata branch selected', ...versionUpdateLogFields(record), metadataBranch, resolved_r2_path: v2Path })
    const ownerOrg = await resolveOwnerOrg(c, record)
    if (!ownerOrg) {
      cloudlog({ requestId: c.get('requestId'), message: 'missing owner_org for app_versions_meta upsert', id: record.id, app_id: record.app_id })
      return c.json(BRES)
    }
    const { error: errorUpdate } = await supabaseAdmin(c)
      .from('app_versions_meta')
      .upsert({
        id: record.id,
        app_id: record.app_id,
        owner_org: ownerOrg,
        size: 0,
        checksum: record.checksum ?? '',
      }, {
        onConflict: 'id',
      })
      .eq('id', record.id)
    if (errorUpdate) {
      cloudlog({ requestId: c.get('requestId'), message: 'errorUpdate', error: errorUpdate, ...versionUpdateLogFields(record), metadataBranch, size: 0 })
    }
    else {
      cloudlog({ requestId: c.get('requestId'), message: 'app_versions_meta zero size upserted', ...versionUpdateLogFields(record), metadataBranch, owner_org: ownerOrg, size: 0 })
    }
  }

  // In-progress r2-direct uploads must use POST /private/set_manifest instead.
  if (record.storage_provider !== 'r2-direct') {
    const recordWithManifest = await ensureVersionManifest(c, record)
    if (recordWithManifest.manifest)
      await handleManifest(c, recordWithManifest)
  }

  return c.json(BRES)
}

const MANIFEST_TRASH_CONCURRENCY = 5

interface ManifestCleanupEntry {
  id: number
  file_hash: string
  file_name: string
  s3_path: string | null
}

interface ManifestCleanupBatchRow extends Record<string, unknown> {
  id: number | null
  file_hash: string | null
  file_name: string | null
  s3_path: string | null
  matched_count: number
}

type ManifestCleanupDatabase = ReturnType<typeof getDrizzleClient>

/**
 * Locks every file of the batch, deletes the rows whose file is still used by
 * another version (or has no R2 object), and returns the rows that hold the
 * last reference so their R2 object can be trashed before the row is dropped.
 *
 * Locks use the same hashtext(file_hash), hashtext(file_name) keys as before,
 * are taken in sorted order (no deadlock between concurrent batches), and are
 * held only for these two statements, never across an R2 call. A per-file lock
 * held over the HEAD/copy/delete round trip made concurrent deletions of
 * versions sharing files queue behind each other file by file.
 */
async function releaseSharedManifestEntries(database: ManifestCleanupDatabase, versionId: number, ids: number[]) {
  return database.transaction(async (tx) => {
    // Do NOT use chr(0) as a separator — Postgres raises 54000 "null character not permitted".
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(k.hash_key, k.name_key)
      FROM (
        SELECT DISTINCT hashtext(file_hash::text) AS hash_key, hashtext(file_name::text) AS name_key
        FROM public.manifest
        WHERE id = ANY(${sql.param(ids)}::bigint[])
          AND app_version_id = ${versionId}
        ORDER BY 1, 2
      ) AS k
    `)
    const batchResult = await tx.execute<ManifestCleanupBatchRow>(sql`
      WITH batch AS (
        SELECT m.id, m.file_hash, m.file_name, m.s3_path,
          COALESCE(m.s3_path, '') = ''
            OR EXISTS (
              SELECT 1
              FROM public.manifest AS other
              WHERE other.file_hash = m.file_hash
                AND other.file_name = m.file_name
                AND other.app_version_id <> m.app_version_id
            ) AS releasable
        FROM public.manifest AS m
        WHERE m.id = ANY(${sql.param(ids)}::bigint[])
          AND m.app_version_id = ${versionId}
      ),
      released AS (
        DELETE FROM public.manifest AS d
        USING batch
        WHERE d.id = batch.id
          AND batch.releasable
        RETURNING d.id
      ),
      last_references AS (
        SELECT id, file_hash, file_name, s3_path
        FROM batch
        WHERE NOT releasable
      )
      SELECT last_references.id, last_references.file_hash, last_references.file_name,
        last_references.s3_path, stats.matched_count
      FROM (SELECT COUNT(*)::int AS matched_count FROM batch) AS stats
      LEFT JOIN last_references ON true
    `)
    return {
      matchedCount: Number(batchResult.rows[0]?.matched_count ?? 0),
      lastReferences: batchResult.rows.flatMap(row => row.id === null
        ? []
        : [{ id: Number(row.id), file_hash: row.file_hash!, file_name: row.file_name!, s3_path: row.s3_path }]),
    }
  })
}

/**
 * Upload registration (`/private/set_manifest`) does not take the cleanup
 * locks, so a new version can start referencing an object between the batch
 * commit and its trash move. Recheck after the move and copy those objects
 * back; the rows of this version are then dropped like any shared file.
 *
 * A failed restore is persisted before raising: on the retry the new row makes
 * this version's row look shared, so it would be released without another
 * restore attempt. retryPendingTrashRestores runs before any release.
 */
async function restoreReReferencedObjects(c: Context, database: ManifestCleanupDatabase, versionId: number, entries: ManifestCleanupEntry[]) {
  const reReferenced = await database.execute<{ s3_path: string }>(sql`
    SELECT DISTINCT s3_path
    FROM public.manifest
    WHERE file_hash = ANY(${sql.param([...new Set(entries.map(entry => entry.file_hash))])}::text[])
      AND s3_path = ANY(${sql.param(entries.map(entry => entry.s3_path!))}::text[])
      AND NOT (id = ANY(${sql.param(entries.map(entry => entry.id))}::bigint[]))
  `)
  const failedPaths: string[] = []
  for (const { s3_path } of reReferenced.rows) {
    cloudlog({ requestId: c.get('requestId'), message: 'manifest object re-referenced during trash, restoring', s3_path })
    if (!await s3.restoreObjectFromTrash(c, s3_path))
      failedPaths.push(s3_path)
  }
  if (failedPaths.length > 0) {
    await database.execute(sql`
      INSERT INTO public.manifest_trash_restore_pending (s3_path, app_version_id)
      SELECT pending.s3_path, ${versionId}
      FROM unnest(${sql.param(failedPaths)}::text[]) AS pending(s3_path)
      ON CONFLICT (app_version_id, s3_path) DO NOTHING
    `)
    simpleError('cannot_restore_manifest_s3_from_trash', 'Cannot restore re-referenced manifest file from trash', {
      s3_path: failedPaths[0],
      failedCount: failedPaths.length,
    })
  }
}

/**
 * Retries restores that failed on an earlier pass for this version. Raises
 * while any is still failing, so no manifest row is released before its
 * re-referenced object is back.
 */
async function retryPendingTrashRestores(c: Context, database: ManifestCleanupDatabase, versionId: number) {
  const pending = await database.execute<{ s3_path: string }>(sql`
    SELECT s3_path
    FROM public.manifest_trash_restore_pending
    WHERE app_version_id = ${versionId}
  `)
  if (pending.rows.length === 0)
    return

  const restoredPaths: string[] = []
  const failedPaths: string[] = []
  for (const { s3_path } of pending.rows) {
    if (await s3.restoreObjectFromTrash(c, s3_path))
      restoredPaths.push(s3_path)
    else
      failedPaths.push(s3_path)
  }
  if (restoredPaths.length > 0) {
    await database.execute(sql`
      DELETE FROM public.manifest_trash_restore_pending
      WHERE app_version_id = ${versionId}
        AND s3_path = ANY(${sql.param(restoredPaths)}::text[])
    `)
  }
  if (failedPaths.length > 0) {
    simpleError('cannot_restore_manifest_s3_from_trash', 'Cannot restore re-referenced manifest file from trash', {
      s3_path: failedPaths[0],
      failedCount: failedPaths.length,
    })
  }
}

/**
 * Trashes the R2 objects of last-reference rows, then deletes only the rows
 * whose object was handled. Rows whose trash failed stay tracked for the retry.
 */
async function trashLastReferenceEntries(c: Context, database: ManifestCleanupDatabase, versionId: number, entries: ManifestCleanupEntry[]) {
  const trashed: ManifestCleanupEntry[] = []
  const failures: { entry: ManifestCleanupEntry, cause?: unknown }[] = []
  let nextEntry = 0
  const workers = Array.from({ length: Math.min(MANIFEST_TRASH_CONCURRENCY, entries.length) }, async () => {
    while (nextEntry < entries.length) {
      const entry = entries[nextEntry++]!
      try {
        if (await s3.moveObjectToTrash(c, entry.s3_path!))
          trashed.push(entry)
        else
          failures.push({ entry })
      }
      catch (cause) {
        failures.push({ entry, cause })
      }
    }
  })
  await Promise.all(workers)

  if (trashed.length > 0) {
    await restoreReReferencedObjects(c, database, versionId, trashed)
    await database.execute(sql`
      DELETE FROM public.manifest
      WHERE id = ANY(${sql.param(trashed.map(entry => entry.id))}::bigint[])
        AND app_version_id = ${versionId}
    `)
  }

  const failure = failures[0]
  if (failure) {
    simpleError('cannot_move_manifest_s3_to_trash', 'Cannot move S3 object for deleted manifest file to trash', {
      id: failure.entry.id,
      s3_path: failure.entry.s3_path,
      failedCount: failures.length,
    }, failure.cause)
  }
}

export async function processManifestCleanupIds(c: Context, versionId: number, manifestIds: number[]) {
  const cleanupPool = getPgClient(c, false)
  try {
    const database = getDrizzleClient(cleanupPool)
    let processedRows = false
    if (manifestIds.length > 0) {
      await retryPendingTrashRestores(c, database, versionId)
      const { lastReferences, matchedCount } = await releaseSharedManifestEntries(database, versionId, manifestIds)
      processedRows = matchedCount > 0
      if (lastReferences.length > 0)
        await trashLastReferenceEntries(c, database, versionId, lastReferences)
    }
    await database.transaction(async (tx) => {
      await tx.execute(sql`
        WITH previous AS (
          SELECT id, app_id, manifest_count, (manifest IS NOT NULL) AS has_json
          FROM public.app_versions
          WHERE id = ${versionId}
            AND (deleted = true OR deleted_at IS NOT NULL)
          FOR UPDATE
        ),
        finalized AS (
          UPDATE public.app_versions AS av
          SET manifest_count = 0,
              manifest = NULL
          FROM previous
          WHERE av.id = previous.id
            AND (previous.manifest_count > 0 OR previous.has_json OR ${processedRows})
            AND NOT EXISTS (
              SELECT 1 FROM public.manifest AS m WHERE m.app_version_id = av.id
            )
          RETURNING previous.app_id, previous.manifest_count AS previous_count
        )
        UPDATE public.apps AS a
        SET manifest_bundle_count = GREATEST(a.manifest_bundle_count - 1, 0),
            updated_at = now()
        FROM finalized
        WHERE a.app_id = finalized.app_id
          AND (finalized.previous_count > 0 OR ${processedRows})
      `)
    })
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'manifest cleanup queue batch failed', error, id: versionId })
    throw error
  }
  finally {
    await closeClient(c, cleanupPool)
  }
}

export async function deleteIt(c: Context, record: Database['public']['Tables']['app_versions']['Row']) {
  cloudlog({ requestId: c.get('requestId'), message: 'Delete', r2_path: record.r2_path })

  await unlinkChannelsFromDeletedVersion(c, record)

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

  // Queue manifest rows before ACK. The bounded queue consumer handles R2 + DB cleanup.
  await enqueueManifestCleanup(c, record.id)

  const { data, error: dbError } = await supabaseAdmin(c)
    .from('app_versions_meta')
    .select()
    .eq('id', record.id)
    .single()
  if (dbError || !data) {
    cloudlog({ requestId: c.get('requestId'), message: 'Cannot find version meta', id: record.id })
  }
  else {
    const { error: errorCreateStatsMeta } = await createStatsMeta(c, record.app_id, record.id, -data.size)
    if (errorCreateStatsMeta)
      cloudlog({ requestId: c.get('requestId'), message: 'error createStatsMeta', error: errorCreateStatsMeta })

    const { error: errorUpdate } = await supabaseAdmin(c)
      .from('app_versions_meta')
      .update({ size: 0 })
      .eq('id', record.id)
    if (errorUpdate) {
      cloudlog({ requestId: c.get('requestId'), message: 'error', error: errorUpdate })
      throw simpleError('cannot_update_version_meta', 'Cannot update version metadata for deleted version', { id: record.id }, errorUpdate)
    }
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
    cloudlog({ requestId: c.get('requestId'), message: 'cleaning manifest for already deleted version', ...versionUpdateLogFields(workRecord, oldRecord) })
    await enqueueManifestCleanup(c, workRecord.id)
    return c.json(BRES)
  }
  if (deletedVersionAction === 'skip')
    return c.json(BRES)

  if (!workRecord.r2_path && !workRecord.manifest) {
    cloudlog({ requestId: c.get('requestId'), message: 'no r2_path and no manifest, skipping update', ...versionUpdateLogFields(workRecord, oldRecord) })
    return c.json(BRES)
  }

  cloudlog({ requestId: c.get('requestId'), message: 'Update but not deleted', ...versionUpdateLogFields(workRecord, oldRecord) })
  return updateIt(c, workRecord)
})

export const onVersionUpdateTestUtils = {
  getDeletedVersionAction,
  handleManifest,
  unlinkChannelsFromDeletedVersion,
}
