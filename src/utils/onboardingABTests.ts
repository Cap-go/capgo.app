import type {
  OnboardingAnalyticsVersion,
  OnboardingDevelopmentEnvironment,
  OnboardingIntent,
} from '~/utils/onboardingProgressAnalytics'
import {
  NEW_CHANNEL_ANALYTICS_VERSION,
  NEW_CHANNEL_DEVELOPMENT_ENVIRONMENT_ANALYTICS_VERSION,
  NEW_CHANNEL_PUBLISH_INTENT_ANALYTICS_VERSION,
  ONBOARDING_ANALYTICS_VERSION,
  WEBNATIVE_DEVELOPMENT_ENVIRONMENT_ANALYTICS_VERSION,
  WEBNATIVE_PUBLISH_INTENT_ANALYTICS_VERSION,
} from '~/utils/onboardingProgressAnalytics'

export const WEBNATIVE_PUBLISH_INTENT_AB_TEST = 'webnativeapp_publish_intent'
export const WEBNATIVE_DEVELOPMENT_ENVIRONMENT_AB_TEST = 'webnativeapp_development_environment'
export const NEW_CHANNEL_AB_TEST = 'new_channel'

export type OnboardingABTestBranch = 'A' | 'B' | 'C' | 'D'

export interface OnboardingABTestAssignment {
  assigned_at: string
  branch: OnboardingABTestBranch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isABTestBranch(value: unknown): value is OnboardingABTestBranch {
  return value === 'A' || value === 'B' || value === 'C' || value === 'D'
}

export function parseOnboardingABTestAssignments(value: unknown): Record<string, OnboardingABTestAssignment> | null {
  if (!isRecord(value))
    return null

  const assignments: Record<string, OnboardingABTestAssignment> = {}
  for (const [testName, assignment] of Object.entries(value)) {
    if (!isRecord(assignment) || typeof assignment.assigned_at !== 'string' || !isABTestBranch(assignment.branch))
      return null
    assignments[testName] = {
      assigned_at: assignment.assigned_at,
      branch: assignment.branch,
    }
  }
  return assignments
}

function getABTestBranch(onboarding: unknown, testName: string): OnboardingABTestBranch | null {
  if (!isRecord(onboarding) || !isRecord(onboarding.abtests))
    return null

  const assignment = onboarding.abtests[testName]
  if (!isRecord(assignment) || !isABTestBranch(assignment.branch))
    return null

  return assignment.branch
}

export function hasWebNativePublishIntentTreatment(onboarding: unknown): boolean {
  return getABTestBranch(onboarding, WEBNATIVE_PUBLISH_INTENT_AB_TEST) === 'A'
}

export function hasWebNativeDevelopmentEnvironmentTreatment(onboarding: unknown): boolean {
  return getABTestBranch(onboarding, WEBNATIVE_DEVELOPMENT_ENVIRONMENT_AB_TEST) === 'C'
}

export function hasNewChannelTreatment(onboarding: unknown): boolean {
  return getABTestBranch(onboarding, NEW_CHANNEL_AB_TEST) === 'A'
}

export function shouldShowWebNativePublishIntent(onboarding: unknown): boolean {
  return hasWebNativePublishIntentTreatment(onboarding)
    || hasWebNativeDevelopmentEnvironmentTreatment(onboarding)
}

export function resolveOnboardingAnalyticsVersion(
  onboarding: unknown,
  intent: OnboardingIntent | null = null,
): OnboardingAnalyticsVersion {
  if (hasNewChannelTreatment(onboarding) && hasWebNativeDevelopmentEnvironmentTreatment(onboarding))
    return NEW_CHANNEL_DEVELOPMENT_ENVIRONMENT_ANALYTICS_VERSION
  if (hasNewChannelTreatment(onboarding) && hasWebNativePublishIntentTreatment(onboarding) && (intent === 'ota' || intent === 'both'))
    return NEW_CHANNEL_PUBLISH_INTENT_ANALYTICS_VERSION
  if (hasNewChannelTreatment(onboarding))
    return NEW_CHANNEL_ANALYTICS_VERSION
  if (hasWebNativeDevelopmentEnvironmentTreatment(onboarding))
    return WEBNATIVE_DEVELOPMENT_ENVIRONMENT_ANALYTICS_VERSION
  if (hasWebNativePublishIntentTreatment(onboarding))
    return WEBNATIVE_PUBLISH_INTENT_ANALYTICS_VERSION
  return ONBOARDING_ANALYTICS_VERSION
}

export function shouldShowWebNativeRecommendation(options: {
  developmentEnvironment: OnboardingDevelopmentEnvironment | null
  dismissed: boolean
  intent: OnboardingIntent | null
  onboarding: unknown
  startingOut: boolean
}): boolean {
  if (options.dismissed || options.intent !== 'publish' || !options.startingOut)
    return false

  return hasWebNativeDevelopmentEnvironmentTreatment(options.onboarding)
    && options.developmentEnvironment === 'hosted_builder'
}
