/** Bento `{{ visitor.uuid }}` is UUID-shaped; keep this looser than RFC version checks. */
export const VISITOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isVisitorUuid(value: string): boolean {
  return VISITOR_UUID_RE.test(value.trim())
}

export function parseEmailPreferencesQuery(query: Record<string, unknown>): {
  email: string
  visitorUuid: string
} {
  const rawEmail = String(query.email ?? '').trim()
  const rawUuid = String(query.uuid ?? '').trim()
  const rawId = String(query.id ?? '').trim()

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
