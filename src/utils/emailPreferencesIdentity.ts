/** Bento `{{ visitor.uuid }}` is UUID-shaped; keep this looser than RFC version checks. */
export const VISITOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isVisitorUuid(value: string): boolean {
  return VISITOR_UUID_RE.test(value.trim())
}

function readQueryParam(value: unknown): string {
  if (value == null)
    return ''
  if (Array.isArray(value)) {
    for (const entry of value) {
      const trimmed = String(entry ?? '').trim()
      if (trimmed)
        return trimmed
    }
    return ''
  }
  return String(value).trim()
}

export function parseEmailPreferencesQuery(query: Record<string, unknown>): {
  email: string
  visitorUuid: string
} {
  const rawEmail = readQueryParam(query.email)
  const rawUuid = readQueryParam(query.uuid)
  const rawId = readQueryParam(query.id)

  let visitorUuid = ''
  if (isVisitorUuid(rawUuid))
    visitorUuid = rawUuid.trim()
  else if (isVisitorUuid(rawId))
    visitorUuid = rawId.trim()
  else if (isVisitorUuid(rawEmail))
    visitorUuid = rawEmail.trim()

  const email = rawEmail && !isVisitorUuid(rawEmail) ? rawEmail : ''

  return { email, visitorUuid }
}
