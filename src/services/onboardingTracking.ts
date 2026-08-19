import { getPostHogBrowserContext } from '~/services/posthog'
import { sendEvent } from '~/services/tracking'

type OnboardingEventProperties = Record<string, string | number | boolean>

const AI_INSTRUCTIONS_COPIED_EVENT = 'onboarding_ai_instructions_copied'

export function sendOnboardingEvent(event: string, properties: OnboardingEventProperties = {}) {
  const orgId = typeof properties.org_id === 'string' ? properties.org_id : undefined
  const appId = typeof properties.app_id === 'string' ? properties.app_id : undefined

  return sendEvent({
    channel: 'onboarding',
    event,
    nonPersonTags: {
      ...properties,
      ...getPostHogBrowserContext(),
    },
    ...(orgId ? { org_id: orgId } : {}),
    ...(event === AI_INSTRUCTIONS_COPIED_EVENT && appId ? { tags: { app_id: appId } } : {}),
    timestamp: Date.now(),
    tracking_version: 2,
  })
}
