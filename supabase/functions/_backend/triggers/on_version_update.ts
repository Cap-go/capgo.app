import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono/tiny'
import { isVersionDeleted, purgeFileReadCache } from '../files/file_read_cache.ts'
import { BRES, middlewareAPISecret, simpleError, triggerValidator } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { persistVersionManifestEntries } from '../utils/manifest_persist.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'
import { manifest } from '../utils/postgres_schema.ts'
import { isCanonicalAppVersionR2Path } from '../utils/app_version_r2_path.ts'
import { getPath, s3 } from '../utils/s3.ts'
import { createStatsMeta } from '../utils/stats.ts'
import { supabaseAdmin } from '../utils/supabase.ts'
import { sendEventToTracking } from '../utils/tracking.ts'

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

const MANIFEST_TRASH_BATCH_SIZE = 5

type ManifestCleanupEntry = {
  id: number
  file_hash: string
  file_name: string
  s3_path: string | null
}

type ManifestCleanupLockMode = 'try' | 'wait'

type ManifestCleanupBatchResult = {
  deferred: ManifestCleanupEntry[]
  failures: ManifestCleanupFailure[]
}

type ManifestCleanupFailure = {
  entry: ManifestCleanupEntry
  cause?: unknown
}

function compareManifestCleanupEntries(a: ManifestCleanupEntry, b: ManifestCleanupEntry) {
  return a.file_hash.localeCompare(b.file_hash)
    || a.file_name.localeCompare(b.file_name)
    || a.id - b.id
}

async function cleanupManifestBatch(
  c: Context,
  database: ReturnType<typeof getDrizzleClient>,
  appVersionId: number,
  batch: ManifestCleanupEntry[],
  lockMode: ManifestCleanupLockMode,
): Promise<ManifestCleanupBatchResult> {
  return database.transaction(async (tx) => {
    const acquired: ManifestCleanupEntry[] = []
    const deferred: ManifestCleanupEntry[] = []
    const lockResults = new Map<string, boolean>()

    for (const entry of batch) {
      const lockKey = JSON.stringify([entry.file_hash, entry.file_name])
      let locked = lockResults.get(lockKey)
      if (locked === undefined) {
        if (lockMode === 'try') {
          const result = await tx.execute<{ locked: boolean }>(sql`
            SELECT pg_try_advisory_xact_lock(hashtext(${entry.file_hash}::text), hashtext(${entry.file_name}::text)) AS locked
          `)
          locked = result.rows[0]?.locked === true
        }
        else {
          await tx.execute(sql`
            SELECT pg_advisory_xact_lock(hashtext(${entry.file_hash}::text), hashtext(${entry.file_name}::text))
          `)
          locked = true
        }
        lockResults.set(lockKey, locked)
      }

      if (locked)
        acquired.push(entry)
      else
        deferred.push(entry)
    }

    const handled: ManifestCleanupEntry[] = []
    const trashByPath = new Map<string, ManifestCleanupEntry[]>()

    for (const entry of acquired) {
      if (!entry.s3_path) {
        handled.push(entry)
        continue
      }

      const refs = await tx.execute<{ ok: number }>(sql`
        SELECT 1 AS ok
        FROM public.manifest
        WHERE file_hash = ${entry.file_hash}
          AND file_name = ${entry.file_name}
          AND app_version_id <> ${appVersionId}
        LIMIT 1
      `)

      if (refs.rows.length > 0) {
        handled.push(entry)
        continue
      }

      const samePathEntries = trashByPath.get(entry.s3_path) ?? []
      samePathEntries.push(entry)
      trashByPath.set(entry.s3_path, samePathEntries)
    }

    const failures: ManifestCleanupFailure[] = []
    const trashGroups = [...trashByPath.entries()]
    const trashResults = await Promise.allSettled(
      trashGroups.map(([path]) => s3.moveObjectToTrash(c, path)),
    )

    for (const [index, result] of trashResults.entries()) {
      const [s3Path, entries] = trashGroups[index]
      if (result.status === 'fulfilled' && result.value) {
        handled.push(...entries)
        continue
      }

      failures.push({
        entry: { ...entries[0], s3_path: s3Path },
        cause: result.status === 'rejected' ? result.reason : undefined,
      })
    }

    if (handled.length > 0) {
      const handledIds = handled.map(entry => entry.id)
      await tx.execute(sql`DELETE FROM public.manifest WHERE id = ANY(${handledIds}::bigint[])`)
    }

    return { deferred, failures }
  })
}

/**
 * Trash unreferenced R2 objects first (exist → move to deleted-after-7-days/,
 * missing → ok), then delete that DB row. Never drop DB tracking before R2 is handled.
 * Batches are committed, so a timeout mid-pass is safe to retry. Leftover rows
 * after the normal retry budget (MAX_QUEUE_READS=5) are reclaimed by
 * sweep_deleted_version_manifests. Incomplete work throws so the queue retries;
 * already-trashed paths are idempotent.
 */
async function deleteManifest(c: Context, record: Database['public']['Tables']['app_versions']['Row']) {
  const readPgClient = getPgClient(c, true)
  const drizzleClient = getDrizzleClient(readPgClient)

  let manifestEntries: ManifestCleanupEntry[] = []
  try {
    manifestEntries = await drizzleClient
      .select({
        id: manifest.id,
        file_hash: manifest.file_hash,
        file_name: manifest.file_name,
        s3_path: manifest.s3_path,
      })
      .from(manifest)
      .where(eq(manifest.app_version_id, record.id))
  }
  finally {
    await closeClient(c, readPgClient)
  }

  const startedWithRows = manifestEntries.length > 0

  if (startedWithRows) {
    const cleanupPool = getPgClient(c, false)
    try {
      const cleanupDatabase = getDrizzleClient(cleanupPool)
      const orderedEntries = [...manifestEntries].sort(compareManifestCleanupEntries)
      const deferred: ManifestCleanupEntry[] = []
      const cleanupFailures: ManifestCleanupFailure[] = []

      // Avoid waiting behind active uploads/deletes until every entry has had
      // one chance to make progress. The second pass waits for any contention.
      for (let i = 0; i < orderedEntries.length; i += MANIFEST_TRASH_BATCH_SIZE) {
        const result = await cleanupManifestBatch(
          c,
          cleanupDatabase,
          record.id,
          orderedEntries.slice(i, i + MANIFEST_TRASH_BATCH_SIZE),
          'try',
        )
        deferred.push(...result.deferred)
        cleanupFailures.push(...result.failures)
      }

      for (let i = 0; i < deferred.length; i += MANIFEST_TRASH_BATCH_SIZE) {
        const result = await cleanupManifestBatch(
          c,
          cleanupDatabase,
          record.id,
          deferred.slice(i, i + MANIFEST_TRASH_BATCH_SIZE),
          'wait',
        )
        cleanupFailures.push(...result.failures)
      }

      if (cleanupFailures.length > 0) {
        const failure = cleanupFailures[0]
        simpleError('cannot_move_manifest_s3_to_trash', 'Cannot move S3 object for deleted manifest file to trash', {
          id: failure.entry.id,
          s3_path: failure.entry.s3_path,
        }, failure.cause)
      }
    }
    finally {
      await closeClient(c, cleanupPool)
    }
  }

  const writePgClient = getPgClient(c, false)
  try {
    await getDrizzleClient(writePgClient).transaction(async (tx) => {
      const remaining = await tx.execute<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count
        FROM public.manifest
        WHERE app_version_id = ${record.id}
      `)
      const remainingCount = Number(remaining.rows[0]?.count ?? 0)
      if (remainingCount > 0) {
        throw simpleError('manifest_cleanup_incomplete', 'Manifest rows still present after trash/delete pass', {
          id: record.id,
          remainingCount,
        })
      }

      await tx.execute(sql`
        WITH prev AS (
          SELECT id, app_id, manifest_count, (manifest IS NOT NULL) AS has_json
          FROM public.app_versions
          WHERE id = ${record.id}
          FOR UPDATE
        ),
        upd AS (
          UPDATE public.app_versions AS av
          SET manifest_count = 0,
              manifest = NULL
          FROM prev
          WHERE av.id = prev.id
            AND (prev.manifest_count > 0 OR prev.has_json OR ${startedWithRows}::boolean)
          RETURNING prev.app_id, prev.manifest_count AS prev_count
        )
        UPDATE public.apps AS a
        SET manifest_bundle_count = GREATEST(a.manifest_bundle_count - 1, 0),
            updated_at = now()
        FROM upd
        WHERE a.app_id = upd.app_id
          AND (upd.prev_count > 0 OR ${startedWithRows}::boolean)
      `)
    })
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'error finalizing manifest cleanup', error, id: record.id })
    throw error
  }
  finally {
    await closeClient(c, writePgClient)
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

  // Manifest files: trash R2 first, then drop DB rows. Must finish before ACK.
  await deleteManifest(c, record)

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
    await deleteManifest(c, workRecord)
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
  deleteManifest,
  unlinkChannelsFromDeletedVersion,
}
