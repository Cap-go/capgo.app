import type { getDrizzleClient } from './pg.ts'
import { sql } from 'drizzle-orm'


/**
 * Finalizes a deleted version's manifest bookkeeping in one transaction.
 * Its version_files row stays: deleted versions keep their file references for
 * the 7-day restore window, and delta storage GC releases the R2 objects
 * afterwards. An inline app_versions.manifest is only cleared once the
 * version has version_files (otherwise it is the only reference GC sees).
 * The version lock is shared with manifest persistence, never with R2 I/O.
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

    await tx.execute(sql`
      WITH prev AS (
        SELECT av.id, av.app_id, av.manifest_count,
          (av.manifest IS NOT NULL AND EXISTS (SELECT 1 FROM public.version_files AS vf WHERE vf.app_version_id = av.id)) AS clear_json
        FROM public.app_versions AS av WHERE av.id = ${versionId}
      ), upd AS (
        UPDATE public.app_versions AS av
        SET manifest_count = 0, manifest = CASE WHEN prev.clear_json THEN NULL ELSE av.manifest END
        FROM prev WHERE av.id = prev.id AND (prev.manifest_count > 0 OR prev.clear_json)
        RETURNING prev.app_id, prev.manifest_count AS prev_count
      )
      UPDATE public.apps AS a
      SET manifest_bundle_count = GREATEST(a.manifest_bundle_count - 1, 0), updated_at = now()
      FROM upd WHERE a.app_id = upd.app_id AND upd.prev_count > 0
    `)
    return { deleted: 0, complete: true }
  })
}
