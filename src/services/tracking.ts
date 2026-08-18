import { defaultApiHost, useSupabase } from '~/services/supabase'

type TagKey = Lowercase<string>
/** Tag Type */
type Tags = Record<TagKey, string | number | boolean>
type Parser = 'markdown' | 'text'
/**
 * Options for publishing analytics events
 */
interface TrackOptions {
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
   * Event icon (emoji)
   * must be a single emoji
   * example: "🎉"
   * @deprecated Tracking v1 presentation hint. Tracking v2 records it as event-only metadata.
   */
  icon?: string
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
   * @deprecated Tracking v2 notifications are controlled by server-side Bento mappings.
   */
  notify?: boolean
  /**
   * @deprecated Tracking v1 presentation hint. Tracking v2 records it as event-only metadata.
   */
  parser?: Parser
  /**
   * Event timestamp
   */
  timestamp?: number | Date
}

export async function sendEvent(payload: TrackOptions): Promise<null> {
  try {
    const { data: currentSession } = await useSupabase().auth.getSession()
    if (!currentSession.session)
      return null

    const currentJwt = currentSession.session.access_token

    // Implement retry logic (3 attempts)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // 10 second timeout using AbortSignal
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 10000)

        const response = await fetch(`${defaultApiHost}/private/events`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${currentJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })

        clearTimeout(timeoutId)

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
    }

    return null
  }
  catch {
    return null
  }
}
