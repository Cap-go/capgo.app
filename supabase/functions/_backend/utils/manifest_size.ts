import type { Context } from 'hono'
import { closeClient, getPgClient } from './pg.ts'

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
SELECT r.file_hash, av.id AS version_id, MAX(m.file_size) AS file_size
FROM requested r
INNER JOIN public.app_versions av
  ON av.id = r.version_id
 AND av.app_id = $2
 AND av.deleted = false
INNER JOIN public.manifest m
  ON m.app_version_id = av.id
 AND m.file_hash = r.file_hash
WHERE r.version_id IS NOT NULL
GROUP BY r.file_hash, av.id`

const MANIFEST_SIZE_FALLBACK_ID_BRANCH = `
SELECT r.file_hash, av.id AS version_id, MAX(m.file_size) AS file_size
FROM requested r
INNER JOIN public.app_versions av
  ON av.id = $3
 AND av.app_id = $2
 AND av.deleted = false
INNER JOIN public.manifest m
  ON m.app_version_id = av.id
 AND m.file_hash = r.file_hash
WHERE r.version_id IS NULL
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

  const lookup = buildManifestSizeLookupQuery(appId, versionName, versionId, files)
  if (!lookup)
    return buildManifestDownloadSizeResult(files, [])

  const pgClient = getPgClient(c, true)
  try {
    const result = await pgClient.query<{ file_hash: string, version_id: number | null, file_size: number | string | null }>(
      lookup.text,
      lookup.values,
    )

    return buildManifestDownloadSizeResult(files, result.rows)
  }
  finally {
    await closeClient(c, pgClient)
  }
}
