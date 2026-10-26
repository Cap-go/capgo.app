import type { getDrizzleClient } from './pg.ts'
import { sql } from 'drizzle-orm'

export const MANIFEST_CLEANUP_BATCH_SIZE = 1000
export const MANIFEST_CLEANUP_MAX_BATCHES = 20
export const MANIFEST_CLEANUP_BUDGET_MS = 10_000

/**
 * Commit a bounded database-only batch. The last deletion and counter update
 * share a transaction, including when legacy rows have manifest_count = 0.
 * The version lock is shared with manifest persistence, never with R2 I/O.
 *
 * Legacy rows are moved into version_files first: deleted versions keep their
 * file references for the 7-day restore window, and delta storage GC releases
 * the R2 objects afterwards. Only onboarding demo rows are deleted in place.
 */
export async function deleteVersionManifestBatch(database: ReturnType<typeof getDrizzleClient>, versionId: number) {
  return database.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '15s'`)
    await tx.execute(sql`SET LOCAL lock_timeout = '2s'`)
    await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(${versionId}::bigint)`)
    const version = await tx.execute<{ deleted: boolean, deleted_at: string | null }>(sql`
      SELECT deleted, deleted_at FROM public.app_versions WHERE id = ${versionId} FOR UPDATE
    `)
    if (!version.rows[0] || (!version.rows[0].deleted && !version.rows[0].deleted_at))
      return { deleted: 0, complete: true }

    const converted = await tx.execute<{ removed: number }>(sql`
      SELECT public.convert_version_manifest_rows(${versionId}::bigint) AS removed
    `)
    const convertedRows = Number(converted.rows[0]?.removed ?? 0)

    // Start on the app_version_id index; no all-manifest scan, ID array, sort,
    // cross-version reference check, or per-file lock/connection is needed.
    const removed = await tx.execute(sql`
      WITH batch AS MATERIALIZED (
        SELECT id FROM public.manifest WHERE app_version_id = ${versionId}
        LIMIT ${MANIFEST_CLEANUP_BATCH_SIZE}
      )
      DELETE FROM public.manifest AS m
      WHERE m.id = ANY(ARRAY(SELECT id FROM batch)) AND m.app_version_id = ${versionId}
    `)
    const remaining = await tx.execute<{ remaining: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM public.manifest WHERE app_version_id = ${versionId}) AS remaining
    `)
    const deleted = convertedRows + (removed.rowCount ?? 0)
    if (remaining.rows[0]?.remaining)
      return { deleted, complete: false }

    await tx.execute(sql`
      WITH prev AS (
        SELECT id, app_id, manifest_count, (manifest IS NOT NULL) AS has_json
        FROM public.app_versions WHERE id = ${versionId}
      ), upd AS (
        UPDATE public.app_versions AS av SET manifest_count = 0, manifest = NULL
        FROM prev WHERE av.id = prev.id
          AND (prev.manifest_count > 0 OR prev.has_json OR ${deleted > 0}::boolean)
        RETURNING prev.app_id, prev.manifest_count AS prev_count
      )
      UPDATE public.apps AS a
      SET manifest_bundle_count = GREATEST(a.manifest_bundle_count - 1, 0), updated_at = now()
      FROM upd WHERE a.app_id = upd.app_id AND (upd.prev_count > 0 OR ${deleted > 0}::boolean)
    `)
    return { deleted, complete: true }
  })
}
