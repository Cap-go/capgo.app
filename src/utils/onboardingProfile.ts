import type { Json } from '~/types/database.types'
import type { OnboardingAnalyticsStep } from '~/utils/onboardingProgressAnalytics'
import { hasNewChannelTreatment } from '~/utils/onboardingABTests'

interface OnboardingProfileUser {
  first_name?: string | null
  last_name?: string | null
  created_via_invite?: boolean
  onboarding?: Json
}

export const PROFILE_ONBOARDING_HANDOFF_KEY = 'capgoProfileOnboardingHandoff'

export function canEditInitialOnboardingName(user: OnboardingProfileUser | null | undefined, hasOrganizations = false): boolean {
  return Boolean(user && !hasOrganizations && !user.created_via_invite)
}

export function needsInitialOnboardingName(user: OnboardingProfileUser | null | undefined, hasOrganizations = false): boolean {
  if (!user || !canEditInitialOnboardingName(user, hasOrganizations))
    return false
  const onboarding = user.onboarding && typeof user.onboarding === 'object' && !Array.isArray(user.onboarding) ? user.onboarding : {}
  const confirmedAt = onboarding.profile_completed_at
  return !user.first_name?.trim() || !user.last_name?.trim()
    || typeof confirmedAt !== 'string' || !Number.isFinite(Date.parse(confirmedAt))
}

export function readProfileOnboardingHandoff(state: unknown): { attemptId: string, runId: string } | null {
  if (!state || typeof state !== 'object')
    return null
  const handoff = (state as Record<string, unknown>)[PROFILE_ONBOARDING_HANDOFF_KEY]
  if (!handoff || typeof handoff !== 'object')
    return null
  const { attemptId, runId } = handoff as Record<string, unknown>
  return typeof attemptId === 'string' && typeof runId === 'string' ? { attemptId, runId } : null
}

export function consumeProfileOnboardingHandoff(history: Pick<History, 'state' | 'replaceState'>): { attemptId: string, runId: string } | null {
  const handoff = readProfileOnboardingHandoff(history.state)
  if (handoff) {
    const { [PROFILE_ONBOARDING_HANDOFF_KEY]: _consumed, ...rest } = history.state as Record<string, unknown>
    history.replaceState(rest, '')
  }
  return handoff
}

export function initialProfileOnboardingSteps(onboarding: unknown, showWelcome: boolean): OnboardingAnalyticsStep[] {
  return [
    ...(showWelcome ? ['welcome' as const] : []),
    'name',
    'intent',
    'app_name',
    'app_icon',
    'organization',
    ...(hasNewChannelTreatment(onboarding) ? ['channel' as const] : []),
    'setup',
  ]
}

export function initialProfileOnboardingProgressSteps(onboarding: unknown): Array<{
  id: 'name' | 'intent' | 'details' | 'organization' | 'channel' | 'setup'
  labelKey: string
}> {
  return [
    { id: 'name', labelKey: 'unified-onboarding-step-about-you' },
    { id: 'intent', labelKey: 'unified-onboarding-step-intent' },
    { id: 'details', labelKey: 'app-onboarding-step-details' },
    { id: 'organization', labelKey: 'unified-onboarding-step-organization' },
    ...(hasNewChannelTreatment(onboarding) ? [{ id: 'channel' as const, labelKey: 'unified-onboarding-step-channel' }] : []),
    { id: 'setup', labelKey: 'unified-onboarding-step-setup' },
  ]
}
