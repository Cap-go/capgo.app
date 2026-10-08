/** Bento visitor ids are UUID-shaped (dashed) or 32 hex chars (footer unsubscribe links). */
const VISITOR_UUID_DASHED_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VISITOR_UUID_HEX32_RE = /^[0-9a-f]{32}$/i

export function isBentoVisitorId(value: string): boolean {
  const trimmed = value.trim()
  return VISITOR_UUID_DASHED_RE.test(trimmed) || VISITOR_UUID_HEX32_RE.test(trimmed)
}

/** Bento `GET /fetch/subscribers` expects the compact 32-char visitor id (see Bento unsubscribe URLs). */
export function normalizeBentoVisitorId(value: string): string | null {
  const trimmed = value.trim().toLowerCase()
  if (VISITOR_UUID_HEX32_RE.test(trimmed))
    return trimmed
  if (VISITOR_UUID_DASHED_RE.test(trimmed))
    return trimmed.replace(/-/g, '')
  return null
}
