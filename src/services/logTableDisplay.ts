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

/** Raw plugin / backend error text keys, in display priority order. */
const LOG_ORIGINAL_MESSAGE_KEYS = [
  'message',
  'error',
  'reason',
  'msg',
  'error_message',
  'detail',
  'description',
] as const

export function extractLogOriginalMessage(metadata: LogMetadata): string | null {
  const normalized = normalizeLogMetadata(metadata)
  if (!normalized)
    return null

  for (const key of LOG_ORIGINAL_MESSAGE_KEYS) {
    const raw = normalized[key]
    if (typeof raw !== 'string')
      continue
    const trimmed = raw.trim()
    if (trimmed)
      return trimmed
  }

  return null
}

export type LogActionLabelMode = 'name' | 'key'

/** Show canonical stats_action under the friendly label when they differ. */
export function shouldShowLogActionCode(action: string, translatedLabel: string): boolean {
  return translatedLabel !== action
}

export function resolveLogActionPrimaryLabel(
  action: string,
  translatedLabel: string,
  mode: LogActionLabelMode,
): string {
  return mode === 'key' ? action : translatedLabel
}

export function shouldShowLogActionCodeLine(
  action: string,
  translatedLabel: string,
  mode: LogActionLabelMode,
): boolean {
  return mode === 'name' && shouldShowLogActionCode(action, translatedLabel)
}

export function formatLogActionLinkTitle(
  action: string,
  translatedLabel: string,
  metadata: LogMetadata,
): string {
  const original = extractLogOriginalMessage(metadata)
  const lines: string[] = []

  if (translatedLabel && translatedLabel !== action)
    lines.push(translatedLabel)
  lines.push(action)
  if (original)
    lines.push(original)

  return lines.join('\n')
}
