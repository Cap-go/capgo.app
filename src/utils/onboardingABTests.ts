import type { OnboardingAnalyticsVersion } from '~/utils/onboardingProgressAnalytics'
import {
  NEW_CHANNEL_ANALYTICS_VERSION,
  ONBOARDING_ANALYTICS_VERSION,
} from '~/utils/onboardingProgressAnalytics'

export const NEW_CHANNEL_AB_TEST = 'new_channel'
export const OTA_TODO_LIST_V3_AB_TEST = 'ota_todo_list_v3'

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

export function reconcileOnboardingABTestAssignments(
  current: Record<string, OnboardingABTestAssignment>,
  authoritative: Record<string, OnboardingABTestAssignment>,
): Record<string, OnboardingABTestAssignment> {
  const next = { ...current }
  delete next[NEW_CHANNEL_AB_TEST]
  return {
    ...next,
    ...authoritative,
  }
}

function getABTestBranch(onboarding: unknown, testName: string): OnboardingABTestBranch | null {
  if (!isRecord(onboarding) || !isRecord(onboarding.abtests))
    return null

  const assignment = onboarding.abtests[testName]
  if (!isRecord(assignment) || !isABTestBranch(assignment.branch))
    return null

  return assignment.branch
}

export function hasNewChannelTreatment(onboarding: unknown): boolean {
  // The new OTA todo list owns channel creation. Its treatment intentionally
  // overrides a simultaneous new-channel treatment so users do not see both.
  return getABTestBranch(onboarding, OTA_TODO_LIST_V3_AB_TEST) !== 'A'
    && getABTestBranch(onboarding, NEW_CHANNEL_AB_TEST) === 'A'
}

export function resolveOnboardingAnalyticsVersion(onboarding: unknown): OnboardingAnalyticsVersion {
  if (hasNewChannelTreatment(onboarding))
    return NEW_CHANNEL_ANALYTICS_VERSION
  return ONBOARDING_ANALYTICS_VERSION
}
