import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  hasWebNativeDevelopmentEnvironmentTreatment,
  hasWebNativePublishIntentTreatment,
  parseOnboardingABTestAssignments,
  resolveOnboardingAnalyticsVersion,
  shouldShowWebNativePublishIntent,
  shouldShowWebNativeRecommendation,
  WEBNATIVE_DEVELOPMENT_ENVIRONMENT_AB_TEST,
  WEBNATIVE_PUBLISH_INTENT_AB_TEST,
} from '../src/utils/onboardingABTests'

const abTestsConfig = JSON.parse(readFileSync(
  new URL('../supabase/functions/_backend/utils/ab_tests.json', import.meta.url),
  'utf8',
)) as Record<string, unknown>

function onboardingFor(publishBranch: 'A' | 'B', environmentBranch: 'C' | 'D') {
  return {
    abtests: {
      [WEBNATIVE_PUBLISH_INTENT_AB_TEST]: {
        assigned_at: '2026-09-01T00:00:00.000Z',
        branch: publishBranch,
      },
      [WEBNATIVE_DEVELOPMENT_ENVIRONMENT_AB_TEST]: {
        assigned_at: '2026-09-01T00:00:00.000Z',
        branch: environmentBranch,
      },
    },
  }
}

describe('webNativeApp onboarding A/B tests', () => {
  it.concurrent('configures independent 25/75 self-signup experiments', () => {
    expect(abTestsConfig[WEBNATIVE_PUBLISH_INTENT_AB_TEST]).toEqual({
      audience: 'self_signup',
      control_branch: 'B',
      treatment_branch: 'A',
      treatment_percentage: 25,
      branches: {
        A: { bento_tag: 'ab:webnativeapp_publish_intent' },
        B: { bento_tag: 'ab:no_webnativeapp_publish_intent' },
      },
    })
    expect(abTestsConfig[WEBNATIVE_DEVELOPMENT_ENVIRONMENT_AB_TEST]).toEqual({
      audience: 'self_signup',
      control_branch: 'D',
      treatment_branch: 'C',
      treatment_percentage: 25,
      branches: {
        C: { bento_tag: 'ab:webnativeapp_development_environment' },
        D: { bento_tag: 'ab:no_webnativeapp_development_environment' },
      },
    })
  })

  it.concurrent('uses 5.C when C is present, then 5.A for A-only users, and otherwise stays on V4', () => {
    expect(resolveOnboardingAnalyticsVersion(onboardingFor('A', 'C'))).toBe('5.C')
    expect(resolveOnboardingAnalyticsVersion(onboardingFor('B', 'C'))).toBe('5.C')
    expect(resolveOnboardingAnalyticsVersion(onboardingFor('A', 'D'))).toBe('5.A')
    expect(resolveOnboardingAnalyticsVersion(onboardingFor('B', 'D'))).toBe(4)
  })

  it.concurrent('shows the publish intent for either treatment and the environment question only for C', () => {
    expect(shouldShowWebNativePublishIntent(onboardingFor('A', 'D'))).toBe(true)
    expect(shouldShowWebNativePublishIntent(onboardingFor('B', 'C'))).toBe(true)
    expect(shouldShowWebNativePublishIntent(onboardingFor('B', 'D'))).toBe(false)
    expect(hasWebNativePublishIntentTreatment(onboardingFor('A', 'D'))).toBe(true)
    expect(hasWebNativeDevelopmentEnvironmentTreatment(onboardingFor('B', 'C'))).toBe(true)
  })

  it.concurrent('requires the hosted-builder answer for C but not for A-only recommendations', () => {
    const publishOnly = onboardingFor('A', 'D')
    const qualified = onboardingFor('B', 'C')
    const base = { dismissed: false, intent: 'publish' as const, startingOut: true }

    expect(shouldShowWebNativeRecommendation({ ...base, developmentEnvironment: null, onboarding: publishOnly })).toBe(true)
    expect(shouldShowWebNativeRecommendation({ ...base, developmentEnvironment: 'hosted_builder', onboarding: qualified })).toBe(true)
    expect(shouldShowWebNativeRecommendation({ ...base, developmentEnvironment: 'local_project', onboarding: qualified })).toBe(false)
    expect(shouldShowWebNativeRecommendation({ ...base, developmentEnvironment: 'hosted_builder', onboarding: onboardingFor('B', 'D') })).toBe(false)
    expect(shouldShowWebNativeRecommendation({ ...base, developmentEnvironment: 'hosted_builder', onboarding: qualified, startingOut: false })).toBe(false)
    expect(shouldShowWebNativeRecommendation({ ...base, developmentEnvironment: 'hosted_builder', dismissed: true, onboarding: qualified })).toBe(false)
  })

  it.concurrent('parses endpoint assignments and rejects malformed payloads', () => {
    const assignments = onboardingFor('A', 'C').abtests
    expect(parseOnboardingABTestAssignments(assignments)).toEqual(assignments)
    expect(parseOnboardingABTestAssignments(null)).toBeNull()
    expect(parseOnboardingABTestAssignments({ invalid: { assigned_at: 12, branch: 'A' } })).toBeNull()
    expect(parseOnboardingABTestAssignments({ invalid: { assigned_at: 'now', branch: 'Z' } })).toBeNull()
  })
})
