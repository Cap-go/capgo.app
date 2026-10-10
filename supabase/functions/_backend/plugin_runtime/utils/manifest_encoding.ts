const PERCENT_ENCODED_OCTET_RE = /%[0-9a-f]{2}/i
const DELTA_OBJECT_SUFFIX_RE = /^(.*\/delta\/[0-9a-f]{64}_)(.+)$/

/** Percent-encode leading dots in a path segment so CDN/WAF rules do not block URL paths. */
export function encodeManifestPathSegment(segment: string): string {
  const encoded = encodeURIComponent(segment)
  if (!segment.startsWith('.'))
    return encoded

  return encoded.replace(/^\./, '%2E')
}

export function encodeManifestPathSegments(path: string): string {
  return path.split('/').map(segment => encodeManifestPathSegment(segment)).join('/')
}

export function decodeManifestPathSegments(path: string): string | null {
  try {
    return path.split('/').map(segment => decodeURIComponent(segment)).join('/')
  }
  catch {
    return null
  }
}

function isSafeManifestPath(path: string): boolean {
  // Postgres text/varchar cannot store U+0000; reject before decode/persist.
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0'))
    return false

  return path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/** True when a string is safe to store in Postgres text/varchar columns. */
export function isPostgresSafeText(value: string): boolean {
  return value.length > 0 && !value.includes('\0')
}

function isValidDeltaFileNamePart(fileNamePart: string): boolean {
  return fileNamePart.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

function dotfileSafeDeltaStoragePath(s3Path: string): string | null {
  const match = s3Path.match(DELTA_OBJECT_SUFFIX_RE)
  if (!match)
    return null

  const [, prefix, fileNamePart] = match
  if (!isValidDeltaFileNamePart(fileNamePart))
    return null
  const encodedFileName = fileNamePart
    .split('/')
    .map(segment => segment.startsWith('.') ? `%2E${segment.slice(1)}` : segment)
    .join('/')
  if (encodedFileName === fileNamePart)
    return null

  return `${prefix}${encodedFileName}`
}

function legacyDotfileDeltaStoragePath(s3Path: string): string | null {
  const match = s3Path.match(DELTA_OBJECT_SUFFIX_RE)
  if (!match)
    return null

  const [, prefix, fileNamePart] = match
  if (!isValidDeltaFileNamePart(fileNamePart))
    return null
  let changed = false
  const legacySegments = fileNamePart.split('/').map((segment) => {
    if (/^%2[Ee]/.test(segment)) {
      changed = true
      try {
        return decodeURIComponent(segment)
      }
      catch {
        return segment
      }
    }
    return segment
  })

  if (!changed)
    return null

  return `${prefix}${legacySegments.join('/')}`
}

export function normalizeLegacyEncodedManifestFileName(fileName: string | null | undefined, s3Path: string | null | undefined): string | null {
  if (fileName == null)
    return null

  if (!s3Path || !PERCENT_ENCODED_OCTET_RE.test(fileName) || !s3Path.endsWith(`_${fileName}`))
    return fileName

  const decodedFileName = decodeManifestPathSegments(fileName)
  if (!decodedFileName || decodedFileName === fileName || !isSafeManifestPath(decodedFileName))
    return fileName

  if (encodeManifestPathSegments(decodedFileName) !== fileName)
    return fileName

  return decodedFileName
}

function collectDotfileDeltaStorageCandidateKeys(s3Path: string): string[] {
  const candidates = [s3Path]

  const legacyDotfile = legacyDotfileDeltaStoragePath(s3Path)
  if (legacyDotfile)
    candidates.push(legacyDotfile)

  const dotfileSafe = dotfileSafeDeltaStoragePath(s3Path)
  if (dotfileSafe)
    candidates.push(dotfileSafe)

  return candidates
}

/** Dotfile delta variants only (raw, legacy decode, WAF-safe encode). Used by attachment reads. */
export function getDotfileDeltaStorageCandidateKeys(s3Path: string): string[] {
  return [...new Set(collectDotfileDeltaStorageCandidateKeys(s3Path))]
}

export function getManifestStorageCandidateKeys(s3Path: string): string[] {
  const candidates = collectDotfileDeltaStorageCandidateKeys(s3Path)

  if (PERCENT_ENCODED_OCTET_RE.test(s3Path)) {
    const decodedPath = decodeManifestPathSegments(s3Path)
    if (decodedPath && decodedPath !== s3Path)
      candidates.push(decodedPath)

    const encodedPath = encodeManifestPathSegments(s3Path)
    if (encodedPath !== s3Path)
      candidates.push(encodedPath)
  }

  return [...new Set(candidates)]
}
