import type { SQL } from 'drizzle-orm'
import { sql } from 'drizzle-orm'

// Plugin reads run on read replicas: only tables, never SQL functions.
// A version's list is served only when its version_files row and every one
// of its delta_files rows are visible (a replica may still be copying them).
// file_ids is TOASTed for any real bundle, so its length is read once per
// version (LATERAL ... OFFSET 0): per output row it would be detoasted again
// for every file, which made a 633-file read about twice as slow.

export interface VersionManifestJsonRow { file_name: string, file_hash: string, s3_path: string }

export function versionManifestJsonSql(versionId: unknown): SQL<VersionManifestJsonRow[]> {
  return sql<VersionManifestJsonRow[]>`COALESCE(
    (SELECT json_agg(json_build_object(
        'file_name', delta_file.file_name,
        'file_hash', delta_file.file_hash,
        's3_path', delta_file.s3_path
      ) ORDER BY entry.ord)
      FROM public.version_files AS version_file
      CROSS JOIN LATERAL (SELECT pg_catalog.cardinality(version_file.file_ids) AS expected OFFSET 0) AS version_size
      CROSS JOIN LATERAL pg_catalog.unnest(version_file.file_ids) WITH ORDINALITY AS entry (file_id, ord)
      INNER JOIN public.delta_files AS delta_file ON delta_file.id = entry.file_id
      WHERE version_file.app_version_id = ${versionId}
      HAVING count(*) = max(version_size.expected)),
    '[]'::json)`
}

// A type alias (not an interface) so it satisfies Record<string, unknown>.
export type VersionManifestRow = { file_name: string, file_hash: string, s3_path: string, expected: number }

// One version's entries as plain rows in upload order: what /updates reads.
// Each row carries the version's expected entry count; use the rows only when
// completeVersionManifest accepts them.
export function versionManifestRowsSql(versionId: unknown): SQL<VersionManifestRow> {
  return sql<VersionManifestRow>`SELECT delta_file.file_name, delta_file.file_hash, delta_file.s3_path, version_size.expected
    FROM public.version_files AS version_file
    CROSS JOIN LATERAL (SELECT pg_catalog.cardinality(version_file.file_ids) AS expected OFFSET 0) AS version_size
    CROSS JOIN LATERAL pg_catalog.unnest(version_file.file_ids) WITH ORDINALITY AS entry (file_id, ord)
    INNER JOIN public.delta_files AS delta_file ON delta_file.id = entry.file_id
    WHERE version_file.app_version_id = ${versionId}
    ORDER BY entry.ord`
}

// Same rule as versionManifestJsonSql: every delta_files row must be visible.
export function completeVersionManifest(rows: readonly VersionManifestRow[]): VersionManifestJsonRow[] {
  if (rows.length === 0 || rows.length !== Number(rows[0].expected))
    return []
  return rows.map(row => ({ file_name: row.file_name, file_hash: row.file_hash, s3_path: row.s3_path }))
}

// Rows (file_hash, file_size) of one version for raw SQL size lookups.
// `versionIdSql` is a SQL expression evaluated once per version row. Like
// versionManifestJsonSql, rows are used only when complete.
export function versionManifestSizeRowsSql(versionIdSql: string): string {
  return `(
  WITH delta AS MATERIALIZED (
    SELECT delta_file.file_hash, delta_file.file_size, version_size.expected
    FROM public.version_files AS version_file
    CROSS JOIN LATERAL (SELECT pg_catalog.cardinality(version_file.file_ids) AS expected OFFSET 0) AS version_size
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
