import { getLocalConfig, isLocal } from '~/services/supabase'
import { sendEvent } from '~/services/tracking'

type OnboardingEventProperties = Record<string, string | number | boolean>
interface PostHogBrowserClient {
  get_property?: (property: string) => unknown
  get_session_id?: () => unknown
}

const AI_INSTRUCTIONS_COPIED_EVENT = 'onboarding_ai_instructions_copied'

function sanitizedUrl(value: string) {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  }
  catch {
    return undefined
  }
}

export function getPostHogBrowserContext(): OnboardingEventProperties {
  const context: OnboardingEventProperties = {}
  const posthogClient = (globalThis as typeof globalThis & { posthog?: PostHogBrowserClient }).posthog

  try {
    const sessionId = posthogClient?.get_session_id?.()
    const windowId = posthogClient?.get_property?.('$window_id')
    const deviceId = posthogClient?.get_property?.('$device_id')
    if (typeof sessionId === 'string')
      context.$session_id = sessionId
    if (typeof windowId === 'string')
      context.$window_id = windowId
    if (typeof deviceId === 'string')
      context.$device_id = deviceId
  }
  catch {
    // Missing PostHog context must never interrupt product analytics.
  }

  if (typeof window !== 'undefined') {
    const currentUrl = sanitizedUrl(window.location.href)
    if (currentUrl)
      context.$current_url = currentUrl
    context.$pathname = window.location.pathname
  }
  if (typeof document !== 'undefined' && document.referrer) {
    const referrer = sanitizedUrl(document.referrer)
    if (referrer)
      context.$referrer = referrer
  }

  return context
}

export function sendOnboardingEvent(event: string, properties: OnboardingEventProperties = {}) {
  if (isLocal(getLocalConfig().supaHost))
    return

  const orgId = typeof properties.org_id === 'string' ? properties.org_id : undefined
  const appId = typeof properties.app_id === 'string' ? properties.app_id : undefined

  void sendEvent({
    channel: 'onboarding',
    event,
    nonPersonTags: {
      ...properties,
      ...getPostHogBrowserContext(),
    },
    ...(orgId ? { org_id: orgId } : {}),
    // The existing Bento mapper requires a verified app tag for this one event.
    // Every onboarding property still remains event-only in nonPersonTags.
    ...(event === AI_INSTRUCTIONS_COPIED_EVENT && appId ? { tags: { app_id: appId } } : {}),
    timestamp: Date.now(),
    tracking_version: 2,
  }).catch(() => {})
}
