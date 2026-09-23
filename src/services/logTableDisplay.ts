export interface ParsedLogVersionName {
  version: string
  filename: string | null
}

export type LogMetadata = Record<string, string> | string | null | undefined

export function parseLogVersionName(versionName: string | null | undefined): ParsedLogVersionName {
  if (!versionName)
    return { version: '', filename: null }

  const colonIndex = versionName.indexOf(':')
  if (colonIndex > 0) {
    const filename = versionName.slice(colonIndex + 1)
    return {
      version: versionName.slice(0, colonIndex),
      filename: filename.length > 0 ? filename : null,
    }
  }

  return {
    version: versionName,
    filename: null,
  }
}

export function normalizeLogMetadata(metadata: LogMetadata): Record<string, string> | null {
  if (!metadata)
    return null
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Record<string, string>
    }
    catch {
      return null
    }
    return null
  }
  return metadata
}

export function logRowDisplayMetadata(versionName: string | null | undefined, metadata: LogMetadata): Record<string, string> | null {
  const parsed = parseLogVersionName(versionName)
  const base = normalizeLogMetadata(metadata) ?? {}
  if (parsed.filename)
    return { ...base, filename: parsed.filename }
  return Object.keys(base).length ? base : null
}
