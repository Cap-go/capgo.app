import type { SQL } from 'drizzle-orm'
import { sql } from 'drizzle-orm'

// Plugin reads run on read replicas: only tables, never SQL functions.
// version_files/delta_files are used when the version row and all of its
// delta_files rows are visible; otherwise legacy manifest rows are served.
// The completeness check covers a replica that is still copying the tables.

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
    (SELECT json_agg(json_build_object(
        'file_name', legacy.file_name,
        'file_hash', legacy.file_hash,
        's3_path', legacy.s3_path
      ))
      FROM public.manifest AS legacy
      WHERE legacy.app_version_id = ${versionId}),
    '[]'::json)`
}

// Rows (file_hash, file_size) of one version for raw SQL size lookups.
// `versionIdSql` is a SQL expression evaluated once per version row.
export function versionManifestSizeRowsSql(versionIdSql: string): string {
  return `(
  SELECT delta_file.file_hash, delta_file.file_size
  FROM public.version_files AS version_file
  CROSS JOIN LATERAL pg_catalog.unnest(version_file.file_ids) AS entry (file_id)
  INNER JOIN public.delta_files AS delta_file ON delta_file.id = entry.file_id
  WHERE version_file.app_version_id = ${versionIdSql}
  UNION ALL
  SELECT legacy.file_hash, legacy.file_size
  FROM public.manifest AS legacy
  WHERE legacy.app_version_id = ${versionIdSql}
    AND NOT EXISTS (SELECT 1 FROM public.version_files AS converted WHERE converted.app_version_id = ${versionIdSql})
)`
}
