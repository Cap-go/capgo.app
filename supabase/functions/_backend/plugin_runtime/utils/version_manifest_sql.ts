import type { SQL } from 'drizzle-orm'
import { sql } from 'drizzle-orm'

// Plugin reads run on read replicas: only tables, never SQL functions.
// A version's list is served only when its version_files row and every one
// of its delta_files rows are visible (a replica may still be copying them).

export interface VersionManifestJsonRow { file_name: string, file_hash: string, s3_path: string }

export function versionManifestJsonSql(versionId: unknown): SQL<VersionManifestJsonRow[]> {
  return sql<VersionManifestJsonRow[]>`COALESCE(
    (SELECT json_agg(json_build_object(
        'file_name', delta_file.file_name,
        'file_hash', delta_file.file_hash,
        's3_path', delta_file.s3_path
      ) ORDER BY entry.ord)
      FROM public.version_files AS version_file
      CROSS JOIN LATERAL pg_catalog.unnest(version_file.file_ids) WITH ORDINALITY AS entry (file_id, ord)
      INNER JOIN public.delta_files AS delta_file ON delta_file.id = entry.file_id
      WHERE version_file.app_version_id = ${versionId}
      HAVING count(*) = max(pg_catalog.cardinality(version_file.file_ids))),
    '[]'::json)`
}

// Rows (file_hash, file_size) of one version for raw SQL size lookups.
// `versionIdSql` is a SQL expression evaluated once per version row. Like
// versionManifestJsonSql, rows are used only when complete.
export function versionManifestSizeRowsSql(versionIdSql: string): string {
  return `(
  WITH delta AS MATERIALIZED (
    SELECT delta_file.file_hash, delta_file.file_size, pg_catalog.cardinality(version_file.file_ids) AS expected
    FROM public.version_files AS version_file
    CROSS JOIN LATERAL pg_catalog.unnest(version_file.file_ids) AS entry (file_id)
    INNER JOIN public.delta_files AS delta_file ON delta_file.id = entry.file_id
    WHERE version_file.app_version_id = ${versionIdSql}
  ),
  delta_complete AS MATERIALIZED (
    SELECT count(*) > 0 AND count(*) = max(delta.expected) AS complete FROM delta
  )
  SELECT delta.file_hash, delta.file_size
  FROM delta
  WHERE (SELECT complete FROM delta_complete)
)`
}
