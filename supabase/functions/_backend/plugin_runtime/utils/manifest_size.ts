import type { Context } from 'hono'
import { CacheHelper } from './cache.ts'
import { closeClient, getPgClient } from './pg.ts'
import { backgroundTask } from './utils.ts'

// Manifest rows are inserted once per version (manifest_persist) and never
// rewritten; only untrusted file_size values get backfilled later by
// on_manifest_create. A version's hash -> size map is therefore stable once
// every size is known, so complete maps are cached for a day per colo.
const MANIFEST_SIZES_CACHE_PATH = '/.manifest-sizes-v1'
const MANIFEST_SIZES_CACHE_TTL_SECONDS = 86400
// A cache miss reads the whole version (one index-only scan, bounded by bundle
// file count) so the map serves every later subset request. Plugin requests are
// scoped to the one bundle being downloaded; requests spanning several versions
// keep the hash-scoped lookup without caching.
const MANIFEST_SIZES_MAX_CACHED_VERSIONS = 1

interface ManifestSizeRow {
  file_hash: string
  // pg returns bigint columns as strings at runtime.
  version_id: number | null
  file_size: number | string | null
}

export interface ManifestSizeRequestFile {
  file_name?: string | null
  file_hash?: string | null
  download_url?: string | null
}

export interface NormalizedManifestSizeFile {
  file_name: string | null
  file_hash: string
  download_url: string | null
  version_id: number | null
}

export interface ManifestSizeResultFile {
  file_name: string | null
  file_hash: string
  download_url: string | null
  size?: number
  error?: string
}

export interface ManifestDownloadSizeResult {
  totalSize: number
  knownFiles: number
  unknownFiles: number
  files: ManifestSizeResultFile[]
}

function versionIdFromDownloadUrl(downloadUrl: string | null | undefined): number | null {
  if (!downloadUrl)
    return null

  try {
    const parsed = new URL(downloadUrl)
    return parseManifestSizeVersionId(parsed.searchParams.get('key')) ?? null
  }
  catch {
    return null
  }
}

export function parseManifestSizeVersionId(value: unknown): number | undefined {
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
  if (typeof value !== 'string')
    return undefined

  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed))
    return undefined

  const versionId = Number.parseInt(trimmed, 10)
  return Number.isSafeInteger(versionId) && versionId > 0 ? versionId : undefined
}

export function normalizeManifestSizeFiles(files: unknown): NormalizedManifestSizeFile[] {
  if (!Array.isArray(files))
    return []

  const normalized: NormalizedManifestSizeFile[] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (!file || typeof file !== 'object')
      continue

    const entry = file as ManifestSizeRequestFile
    if (typeof entry.file_hash !== 'string' || !entry.file_hash)
      continue

    const fileName = typeof entry.file_name === 'string' ? entry.file_name : null
    const downloadUrl = typeof entry.download_url === 'string' ? entry.download_url : null
    const key = `${fileName ?? ''}\u0000${entry.file_hash}\u0000${downloadUrl ?? ''}`
    if (seen.has(key))
      continue

    seen.add(key)
    normalized.push({
      file_name: fileName,
      file_hash: entry.file_hash,
      download_url: downloadUrl,
      version_id: versionIdFromDownloadUrl(downloadUrl),
    })
  }
  return normalized
}

export function buildManifestDownloadSizeResult(
  files: NormalizedManifestSizeFile[],
  rows: Array<{ file_hash: string, version_id: number | null, file_size: number | string | null }>,
): ManifestDownloadSizeResult {
  const sizesByVersionAndHash = new Map<string, number>()
  const sizesByHash = new Map<string, number>()

  for (const row of rows) {
    const size = typeof row.file_size === 'string' ? Number.parseInt(row.file_size, 10) : row.file_size
    if (!Number.isFinite(size) || size === null || size <= 0)
      continue

    if (row.version_id)
      sizesByVersionAndHash.set(`${row.version_id}:${row.file_hash}`, size)
    sizesByHash.set(row.file_hash, Math.max(sizesByHash.get(row.file_hash) ?? 0, size))
  }

  let totalSize = 0
  let knownFiles = 0
  let unknownFiles = 0
  const resultFiles = files.map((file): ManifestSizeResultFile => {
    const size = file.version_id
      ? sizesByVersionAndHash.get(`${file.version_id}:${file.file_hash}`) ?? sizesByHash.get(file.file_hash)
      : sizesByHash.get(file.file_hash)

    if (typeof size === 'number' && size > 0) {
      totalSize += size
      knownFiles += 1
      return {
        file_name: file.file_name,
        file_hash: file.file_hash,
        download_url: file.download_url,
        size,
      }
    }

    unknownFiles += 1
    return {
      file_name: file.file_name,
      file_hash: file.file_hash,
      download_url: file.download_url,
      error: 'size_unknown',
    }
  })

  return {
    totalSize,
    knownFiles,
    unknownFiles,
    files: resultFiles,
  }
}

export interface ManifestSizeLookupQuery {
  text: string
  values: [string, string] | [string, string, number | string]
}

const MANIFEST_SIZE_REQUESTED_CTE = `
WITH requested AS MATERIALIZED (
  SELECT DISTINCT file_hash, version_id
  FROM jsonb_to_recordset($1::jsonb) AS request_files(file_hash text, version_id bigint)
  WHERE file_hash IS NOT NULL
)`

const MANIFEST_SIZE_FILE_VERSION_BRANCH = `
, allowed_versions AS MATERIALIZED (
  SELECT av.id
  FROM (
    SELECT DISTINCT version_id
    FROM requested
    WHERE version_id IS NOT NULL
  ) ids
  INNER JOIN LATERAL (
    SELECT id, app_id, deleted
    FROM public.app_versions
    WHERE id = ids.version_id
    OFFSET 0
  ) av ON av.app_id = $2 AND av.deleted = false
)
SELECT r.file_hash, av.id AS version_id, MAX(m.file_size) AS file_size
FROM requested r
INNER JOIN allowed_versions av ON av.id = r.version_id
INNER JOIN public.manifest m
  ON m.app_version_id = av.id
 AND m.file_hash = r.file_hash
WHERE r.version_id IS NOT NULL
GROUP BY r.file_hash, av.id`

const MANIFEST_SIZE_FALLBACK_ID_BRANCH = `
SELECT r.file_hash, av.id AS version_id, MAX(m.file_size) AS file_size
FROM requested r
CROSS JOIN (
  SELECT id, app_id, deleted
  FROM public.app_versions
  WHERE id = $3
  OFFSET 0
) av
INNER JOIN public.manifest m
  ON m.app_version_id = av.id
 AND m.file_hash = r.file_hash
WHERE r.version_id IS NULL
  AND av.app_id = $2
  AND av.deleted = false
GROUP BY r.file_hash, av.id`

const MANIFEST_SIZE_FALLBACK_NAME_BRANCH = `
SELECT r.file_hash, av.id AS version_id, MAX(m.file_size) AS file_size
FROM requested r
INNER JOIN public.app_versions av
  ON av.app_id = $2
 AND av.name = $3
 AND av.deleted = false
INNER JOIN public.manifest m
  ON m.app_version_id = av.id
 AND m.file_hash = r.file_hash
WHERE r.version_id IS NULL
GROUP BY r.file_hash, av.id`

export function buildManifestSizeLookupQuery(
  appId: string,
  versionName: string | undefined,
  versionId: number | undefined,
  files: NormalizedManifestSizeFile[],
): ManifestSizeLookupQuery | null {
  const fallbackId = versionId ?? null
  const fallbackName = versionName && versionName.length > 0 ? versionName : null
  const hasFileVersion = files.some(file => file.version_id != null)
  const hasUnscoped = files.some(file => file.version_id == null)
  const branches: string[] = []
  if (hasFileVersion)
    branches.push(MANIFEST_SIZE_FILE_VERSION_BRANCH)
  if (hasUnscoped && fallbackId != null)
    branches.push(MANIFEST_SIZE_FALLBACK_ID_BRANCH)
  else if (hasUnscoped && fallbackName != null)
    branches.push(MANIFEST_SIZE_FALLBACK_NAME_BRANCH)
  if (branches.length === 0)
    return null

  const payload = JSON.stringify(files.map(file => ({ file_hash: file.file_hash, version_id: file.version_id })))
  let values: ManifestSizeLookupQuery['values'] = [payload, appId]
  if (hasUnscoped && fallbackId != null)
    values = [payload, appId, fallbackId]
  else if (hasUnscoped && fallbackName != null)
    values = [payload, appId, fallbackName]

  return {
    text: `${MANIFEST_SIZE_REQUESTED_CTE}\n${branches.join('\nUNION ALL\n')}`,
    values,
  }
}

export function buildManifestVersionSizesQuery(appId: string, versionIds: number[]) {
  return {
    text: `
SELECT av.id AS version_id, m.file_hash, MAX(m.file_size) AS file_size
FROM pg_catalog.unnest($1::bigint[]) AS ids(version_id)
INNER JOIN LATERAL (
  SELECT id, app_id, deleted
  FROM public.app_versions
  WHERE id = ids.version_id
  OFFSET 0
) av ON av.app_id = $2 AND av.deleted = false
INNER JOIN public.manifest m ON m.app_version_id = av.id
GROUP BY av.id, m.file_hash`,
    values: [versionIds, appId] as [number[], string],
  }
}

function parseManifestFileSize(value: number | string | null): number | null {
  const size = typeof value === 'string' ? Number.parseInt(value, 10) : value
  return typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : null
}

// Groups whole-version rows into hash -> size maps. A version with any unknown
// size is still being backfilled and gets no map, so it is not cached.
export function buildCompleteManifestVersionSizes(rows: ManifestSizeRow[]): Map<number, Record<string, number>> {
  const sizesByVersion = new Map<number, Record<string, number> | null>()
  for (const row of rows) {
    const versionId = Number(row.version_id)
    const sizes = sizesByVersion.get(versionId)
    if (sizes === null)
      continue
    const size = parseManifestFileSize(row.file_size)
    if (size === null) {
      sizesByVersion.set(versionId, null)
      continue
    }
    if (sizes) {
      sizes[row.file_hash] = size
    }
    else {
      // Null prototype: a "__proto__" file hash must stay an own key.
      const versionSizes = Object.create(null) as Record<string, number>
      versionSizes[row.file_hash] = size
      sizesByVersion.set(versionId, versionSizes)
    }
  }

  const complete = new Map<number, Record<string, number>>()
  for (const [versionId, sizes] of sizesByVersion) {
    if (sizes)
      complete.set(versionId, sizes)
  }
  return complete
}

async function queryManifestSizeRows(c: Context, queries: Array<{ text: string, values: unknown[] }>): Promise<ManifestSizeRow[][]> {
  const pgClient = await getPgClient(c, true)
  try {
    // Hyperdrive clients hold one connection, so run the lookups in sequence.
    const results: ManifestSizeRow[][] = []
    for (const query of queries) {
      const result = await pgClient.query<ManifestSizeRow>(query.text, query.values)
      results.push(result.rows)
    }
    return results
  }
  finally {
    await closeClient(c, pgClient)
  }
}

export async function getManifestDownloadSize(
  c: Context,
  appId: string,
  versionName: string | undefined,
  versionId: number | undefined,
  filesInput: unknown,
): Promise<ManifestDownloadSizeResult> {
  const files = normalizeManifestSizeFiles(filesInput)
  if (files.length === 0) {
    return {
      totalSize: 0,
      knownFiles: 0,
      unknownFiles: 0,
      files: [],
    }
  }

  const scopedVersionIds = [...new Set(files.flatMap(file => file.version_id == null ? [] : [file.version_id]))]
  if (scopedVersionIds.length === 0 || scopedVersionIds.length > MANIFEST_SIZES_MAX_CACHED_VERSIONS) {
    const lookup = buildManifestSizeLookupQuery(appId, versionName, versionId, files)
    if (!lookup)
      return buildManifestDownloadSizeResult(files, [])
    const [rows] = await queryManifestSizeRows(c, [lookup])
    return buildManifestDownloadSizeResult(files, rows)
  }

  // Download URLs carry the bundle id, so plugin requests are almost always
  // scoped to one version: serve its hash -> size map from Cache API.
  const helper = new CacheHelper(c)
  const cacheKeys = new Map(scopedVersionIds.map(id => [id, helper.buildRequest(MANIFEST_SIZES_CACHE_PATH, { app_id: appId, version_id: String(id) })]))
  const cachedSizes = await Promise.all(scopedVersionIds.map(id => helper.matchJson<Record<string, number>>(cacheKeys.get(id)!)))

  const rows: ManifestSizeRow[] = []
  const missingVersionIds: number[] = []
  scopedVersionIds.forEach((id, index) => {
    const sizes = cachedSizes[index]
    if (!sizes) {
      missingVersionIds.push(id)
      return
    }
    for (const [fileHash, fileSize] of Object.entries(sizes))
      rows.push({ file_hash: fileHash, version_id: id, file_size: fileSize })
  })

  const queries: Array<{ text: string, values: unknown[] }> = []
  if (missingVersionIds.length > 0)
    queries.push(buildManifestVersionSizesQuery(appId, missingVersionIds))
  const unscopedLookup = buildManifestSizeLookupQuery(appId, versionName, versionId, files.filter(file => file.version_id == null))
  if (unscopedLookup)
    queries.push(unscopedLookup)
  if (queries.length === 0)
    return buildManifestDownloadSizeResult(files, rows)

  const results = await queryManifestSizeRows(c, queries)
  if (missingVersionIds.length > 0) {
    const versionRows = results[0]
    for (const [id, sizes] of buildCompleteManifestVersionSizes(versionRows)) {
      const cacheKey = cacheKeys.get(id)
      if (cacheKey)
        await backgroundTask(c, helper.putJson(cacheKey, sizes, MANIFEST_SIZES_CACHE_TTL_SECONDS))
    }
  }
  for (const result of results)
    rows.push(...result)
  return buildManifestDownloadSizeResult(files, rows)
}
