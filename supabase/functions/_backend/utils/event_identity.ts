// A supplied ID identifies one logical event, not a request or a provider delivery.
const CLIENT_EVENT_ID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i
const MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
const ISO_TIMESTAMP = /^(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

function parseIsoTimestamp(value: unknown): number {
  if (typeof value !== 'string')
    return Number.NaN
  const match = ISO_TIMESTAMP.exec(value)
  if (!match || match[0] !== value)
    return Number.NaN
  // Date.parse normalizes impossible calendar dates. Verify the local date
  // independently of the explicit timezone before converting the whole instant.
  const calendarDate = new Date(`${match[1]}T00:00:00Z`)
  if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== match[1])
    return Number.NaN
  return Date.parse(value)
}

export function isValidClientEventId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && CLIENT_EVENT_ID.test(value)
}

export interface AcceptedEventIdentity {
  event_id: string
  occurred_at: string
  accepted_at: string
  id_source: 'client' | 'server'
  timestamp_source: 'client' | 'server' | 'clamped'
}

export async function acceptEventIdentity(input: {
  actorId: string
  orgId?: string
  clientEventId?: string
  timestamp?: unknown
  acceptedAt: number
}): Promise<AcceptedEventIdentity> {
  const clientEventId = input.clientEventId ?? crypto.randomUUID()
  // UUIDv8 from a SHA-256 digest. Include only authenticated/verified scope;
  // JSON tuple encoding prevents delimiter collisions and versions the namespace.
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
    'capgo.private.events.v1',
    input.actorId,
    input.orgId ?? null,
    clientEventId.toLowerCase(),
  ]))))
  digest[6] = (digest[6] & 0x0F) | 0x80
  digest[8] = (digest[8] & 0x3F) | 0x80
  const hex = Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')
  const eventId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`

  // Accept the numeric millisecond contract and ISO dates serialized by old clients.
  const timestamp = typeof input.timestamp === 'number'
    ? input.timestamp
    : parseIsoTimestamp(input.timestamp)
  const validTimestamp = Number.isFinite(timestamp) && Number.isFinite(new Date(timestamp).getTime())
  const reasonableTimestamp = validTimestamp
    && timestamp >= input.acceptedAt - MAX_EVENT_AGE_MS
    && timestamp <= input.acceptedAt + MAX_FUTURE_SKEW_MS
  return {
    event_id: eventId,
    occurred_at: new Date(reasonableTimestamp ? timestamp : input.acceptedAt).toISOString(),
    accepted_at: new Date(input.acceptedAt).toISOString(),
    id_source: input.clientEventId === undefined ? 'server' : 'client',
    timestamp_source: reasonableTimestamp ? 'client' : validTimestamp ? 'clamped' : 'server',
  }
}
