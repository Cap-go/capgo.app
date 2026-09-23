import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  hasNewChannelTreatment,
  hasWebNativeDevelopmentEnvironmentTreatment,
  hasWebNativePublishIntentTreatment,
  NEW_CHANNEL_AB_TEST,
  parseOnboardingABTestAssignments,
  reconcileOnboardingABTestAssignments,
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

function onboardingWithNewChannel(
  publishBranch: 'A' | 'B',
  environmentBranch: 'C' | 'D',
  channelBranch: 'A' | 'B',
) {
  const onboarding = onboardingFor(publishBranch, environmentBranch)
  return {
    ...onboarding,
    abtests: {
      ...onboarding.abtests,
      [NEW_CHANNEL_AB_TEST]: {
        assigned_at: '2026-09-10T00:00:00.000Z',
        branch: channelBranch,
      },
    },
  }
}

describe('webNativeApp onboarding A/B tests', () => {
  it.concurrent('configures independent 25/75 self-signup experiments', () => {
    expect(abTestsConfig[WEBNATIVE_PUBLISH_INTENT_AB_TEST]).toEqual({
      audience: 'self_signup',
      comment: 'Shows a \'convert my webapp to mobile\' intent option. Does not change the rest of the flow by itself.',
      control_branch: 'B',
      label: 'Publish intent',
      treatment_branch: 'A',
      treatment_percentage: 25,
      branches: {
        A: { bento_tag: 'ab:webnativeapp_publish_intent', label: 'WebNativeApp option' },
        B: { bento_tag: 'ab:no_webnativeapp_publish_intent', label: 'Current publish options' },
      },
    })
    expect(abTestsConfig[WEBNATIVE_DEVELOPMENT_ENVIRONMENT_AB_TEST]).toEqual({
      audience: 'self_signup',
      comment: 'Asks what tools people use to build. Combined with publish + hosted_builder + starting out, this can recommend WebNativeApp.',
      control_branch: 'D',
      label: 'Development environment',
      treatment_branch: 'C',
      treatment_percentage: 25,
      branches: {
        C: { bento_tag: 'ab:webnativeapp_development_environment', label: 'Development environment question' },
        D: { bento_tag: 'ab:no_webnativeapp_development_environment', label: 'Current onboarding' },
      },
    })
  })

  it.concurrent('configures a 50/50 channel experiment for exact OTA and both intents', () => {
    expect(abTestsConfig[NEW_CHANNEL_AB_TEST]).toEqual({
      audience: 'self_signup',
      comment: 'Shows the guided channel education and creation flow.',
      control_branch: 'B',
      intents: ['ota', 'both'],
      label: 'Channel creation',
      treatment_branch: 'A',
      treatment_percentage: 50,
      branches: {
        A: { bento_tag: 'ab:new_channel', label: 'Guided channel flow' },
        B: { bento_tag: 'ab:no_new_channel', label: 'Current channel flow' },
      },
    })
  })

  it.concurrent('uses 5.C when C is present, then 5.A for A-only users, and otherwise stays on V4', () => {
    expect(resolveOnboardingAnalyticsVersion(onboardingFor('A', 'C'))).toBe('5.C')
    expect(resolveOnboardingAnalyticsVersion(onboardingFor('B', 'C'))).toBe('5.C')
    expect(resolveOnboardingAnalyticsVersion(onboardingFor('A', 'D'))).toBe('5.A')
    expect(resolveOnboardingAnalyticsVersion(onboardingFor('B', 'D'))).toBe(4)
  })

  it.concurrent('uses the channel experiment analytics versions with explicit precedence', () => {
    expect(resolveOnboardingAnalyticsVersion(onboardingWithNewChannel('B', 'D', 'A'), 'ota')).toBe('5.E')
    expect(resolveOnboardingAnalyticsVersion(onboardingWithNewChannel('A', 'C', 'A'), 'ota')).toBe('5.F')
    expect(resolveOnboardingAnalyticsVersion(onboardingWithNewChannel('A', 'D', 'A'), 'ota')).toBe('5.G')
    expect(resolveOnboardingAnalyticsVersion(onboardingWithNewChannel('A', 'D', 'A'), 'both')).toBe('5.G')
    expect(resolveOnboardingAnalyticsVersion(onboardingWithNewChannel('A', 'D', 'A'), 'builder')).toBe('5.E')
    expect(resolveOnboardingAnalyticsVersion(onboardingWithNewChannel('A', 'D', 'B'), 'ota')).toBe('5.A')
    expect(hasNewChannelTreatment(onboardingWithNewChannel('B', 'D', 'A'))).toBe(true)
    expect(hasNewChannelTreatment(onboardingWithNewChannel('B', 'D', 'B'))).toBe(false)
  })

  it.concurrent('shows the publish intent for either treatment and the environment question only for C', () => {
    expect(shouldShowWebNativePublishIntent(onboardingFor('A', 'D'))).toBe(true)
    expect(shouldShowWebNativePublishIntent(onboardingFor('B', 'C'))).toBe(true)
    expect(shouldShowWebNativePublishIntent(onboardingFor('B', 'D'))).toBe(false)
    expect(hasWebNativePublishIntentTreatment(onboardingFor('A', 'D'))).toBe(true)
    expect(hasWebNativeDevelopmentEnvironmentTreatment(onboardingFor('B', 'C'))).toBe(true)
  })

  it.concurrent('requires treatment C and the hosted-builder answer for recommendations', () => {
    const publishOnly = onboardingFor('A', 'D')
    const qualified = onboardingFor('B', 'C')
    const base = { dismissed: false, intent: 'publish' as const, startingOut: true }

    expect(shouldShowWebNativeRecommendation({ ...base, developmentEnvironment: null, onboarding: publishOnly })).toBe(false)
    expect(shouldShowWebNativeRecommendation({ ...base, developmentEnvironment: 'hosted_builder', onboarding: publishOnly })).toBe(false)
    expect(shouldShowWebNativeRecommendation({ ...base, developmentEnvironment: 'hosted_builder', onboarding: qualified })).toBe(true)
    expect(shouldShowWebNativeRecommendation({ ...base, developmentEnvironment: 'local_project', onboarding: qualified })).toBe(false)
    expect(shouldShowWebNativeRecommendation({ ...base, developmentEnvironment: 'ai_assistant', onboarding: qualified })).toBe(false)
    expect(shouldShowWebNativeRecommendation({ ...base, developmentEnvironment: 'hand_coded', onboarding: qualified })).toBe(false)
    expect(shouldShowWebNativeRecommendation({ ...base, developmentEnvironment: 'other', onboarding: qualified })).toBe(false)
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

  it.concurrent('removes a revoked channel assignment while preserving unrelated tests', () => {
    const current = onboardingWithNewChannel('A', 'D', 'A').abtests
    const authoritative = onboardingFor('A', 'D').abtests

    expect(reconcileOnboardingABTestAssignments(current, authoritative)).toEqual(authoritative)
  })
})
