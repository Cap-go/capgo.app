import { defaultApiHost, useConsole } from '~/services/console'

const KEEPALIVE_BODY_LIMIT = 64 * 1024
let reservedKeepaliveBytes = 0

function reserveKeepalive(bodySize: number): boolean {
  if (reservedKeepaliveBytes + bodySize > KEEPALIVE_BODY_LIMIT)
    return false

  reservedKeepaliveBytes += bodySize
  return true
}

function releaseKeepalive(bodySize: number): void {
  reservedKeepaliveBytes -= bodySize
}

type TagKey = Lowercase<string>
/** Tag Type */
type Tags = Record<TagKey, string | number | boolean>
/**
 * Options for publishing analytics events
 */
interface TrackOptions {
  /** Stable identity for this event across delivery attempts. */
  client_event_id?: string
  /**
   * Channel name
   * example: "waitlist"
   */
  channel: string
  /**
   * Event name
   * example: "User Joined"
   */
  event: string
  /**
   * Event description
   * example: "joe@example.com joined waitlist"
   */
  description?: string
  /**
   * User ID
   * example: "user-123"
   */
  user_id?: string
  /**
   * Organization ID for actor-scoped tracking.
   */
  org_id?: string
  /**
   * Tracking payload contract version.
   */
  tracking_version?: number
  /**
   * Event tags
   * example: { username: "mattie" }
   */
  tags?: Tags
  /**
   * Per-event metadata that must not become PostHog person properties.
   */
  nonPersonTags?: Tags
  /**
   * Event timestamp
   */
  timestamp?: number | Date
}

export async function sendEvent(payload: TrackOptions): Promise<null> {
  try {
    const { data: currentSession } = await useConsole().auth.getSession()
    if (!currentSession.session)
      return null

    const currentJwt = currentSession.session.access_token
    const clientEventId = payload.client_event_id ?? crypto.randomUUID()
    const timestamp = payload.timestamp instanceof Date ? payload.timestamp.getTime() : payload.timestamp ?? Date.now()
    const body = JSON.stringify({ ...payload, client_event_id: clientEventId, timestamp })
    const bodySize = new TextEncoder().encode(body).byteLength

    // Implement retry logic (3 attempts)
    for (let attempt = 0; attempt < 3; attempt++) {
      // Browsers reject keepalive requests once their in-flight bodies exceed 64 KiB.
      const keepalive = reserveKeepalive(bodySize)
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 10000)

      try {
        // 10 second timeout using AbortSignal
        const response = await fetch(`${defaultApiHost}/private/events`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${currentJwt}`,
            'Content-Type': 'application/json',
          },
          body,
          keepalive,
          signal: controller.signal,
        })

        // Consume response to avoid memory leaks, but don't throw on errors
        if (!response.ok) {
          await response.text().catch(() => {})
          // Retry on server errors (5xx)
          if (response.status >= 500 && attempt < 2) {
            continue
          }
        }

        return null
      }
      catch (error) {
        // If it's a timeout or network error and we have retries left, continue
        if (attempt < 2 && (error instanceof Error && (error.name === 'AbortError' || error.message.includes('fetch')))) {
          continue
        }
        // Last attempt failed, return null
        return null
      }
      finally {
        clearTimeout(timeoutId)
        if (keepalive)
          releaseKeepalive(bodySize)
      }
    }

    return null
  }
  catch {
    return null
  }
}
