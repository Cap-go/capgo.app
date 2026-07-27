const PERCENT_ENCODED_OCTET_RE = /%[0-9a-f]{2}/i

export function encodeManifestPathSegments(path: string): string {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/')
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

export function getManifestStorageCandidateKeys(s3Path: string): string[] {
  const candidates = [s3Path]

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
