import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  hasNewChannelTreatment,
  NEW_CHANNEL_AB_TEST,
  OTA_TODO_LIST_V3_AB_TEST,
  parseOnboardingABTestAssignments,
  reconcileOnboardingABTestAssignments,
  resolveOnboardingAnalyticsVersion,
} from '../src/utils/onboardingABTests'

const abTestsConfig = JSON.parse(readFileSync(
  new URL('../supabase/functions/_backend/utils/ab_tests.json', import.meta.url),
  'utf8',
)) as Record<string, unknown>

// Historical assignments for the retired publish/development-environment tests
// still exist on users; they must not change anything anymore.
const RETIRED_ASSIGNMENTS = {
  webnativeapp_publish_intent: { assigned_at: '2026-09-01T00:00:00.000Z', branch: 'A' },
  webnativeapp_development_environment: { assigned_at: '2026-09-01T00:00:00.000Z', branch: 'C' },
} as const

function onboardingWithNewChannel(channelBranch: 'A' | 'B') {
  return {
    abtests: {
      ...RETIRED_ASSIGNMENTS,
      [NEW_CHANNEL_AB_TEST]: {
        assigned_at: '2026-09-10T00:00:00.000Z',
        branch: channelBranch,
      },
    },
  }
}

describe('onboarding A/B tests', () => {
  it.concurrent('retires the publish intent and development environment experiments', () => {
    expect(Object.keys(abTestsConfig)).not.toContain('webnativeapp_publish_intent')
    expect(Object.keys(abTestsConfig)).not.toContain('webnativeapp_development_environment')
    expect(JSON.stringify(abTestsConfig).toLowerCase()).not.toContain('webnative')
  })

  it.concurrent('pauses new channel experiment assignments for exact OTA and both intents', () => {
    expect(abTestsConfig[NEW_CHANNEL_AB_TEST]).toEqual({
      audience: 'self_signup',
      comment: 'Shows the guided channel education and creation flow.',
      control_branch: 'B',
      intents: ['ota', 'both'],
      label: 'Channel creation',
      treatment_branch: 'A',
      treatment_percentage: 0,
      branches: {
        A: { bento_tag: 'ab:new_channel', label: 'Guided channel flow' },
        B: { bento_tag: 'ab:no_new_channel', label: 'Current channel flow' },
      },
    })
  })

  it.concurrent('stays on V4 for retired assignments and uses 5.E for the channel treatment', () => {
    expect(resolveOnboardingAnalyticsVersion({ abtests: RETIRED_ASSIGNMENTS })).toBe(4)
    expect(resolveOnboardingAnalyticsVersion({})).toBe(4)
    expect(resolveOnboardingAnalyticsVersion(onboardingWithNewChannel('A'))).toBe('5.E')
    expect(resolveOnboardingAnalyticsVersion(onboardingWithNewChannel('B'))).toBe(4)
    expect(hasNewChannelTreatment(onboardingWithNewChannel('A'))).toBe(true)
    expect(hasNewChannelTreatment(onboardingWithNewChannel('B'))).toBe(false)
  })

  it.concurrent('parses endpoint assignments and rejects malformed payloads', () => {
    const assignments = onboardingWithNewChannel('A').abtests
    expect(parseOnboardingABTestAssignments(assignments)).toEqual(assignments)
    expect(parseOnboardingABTestAssignments(null)).toBeNull()
    expect(parseOnboardingABTestAssignments({ invalid: { assigned_at: 12, branch: 'A' } })).toBeNull()
    expect(parseOnboardingABTestAssignments({ invalid: { assigned_at: 'now', branch: 'Z' } })).toBeNull()
  })

  it.concurrent('removes a revoked channel assignment while preserving unrelated tests', () => {
    const current = onboardingWithNewChannel('A').abtests
    const authoritative = { ...RETIRED_ASSIGNMENTS }

    expect(reconcileOnboardingABTestAssignments(current, authoritative)).toEqual(authoritative)
  })
})

describe('channel and checklist experiment interaction', () => {
  it.concurrent('explicitly disables the channel treatment when the new todo list is assigned', () => {
    const channelTreatment = onboardingWithNewChannel('A')
    const combinedTreatment = {
      ...channelTreatment,
      abtests: {
        ...channelTreatment.abtests,
        [OTA_TODO_LIST_V3_AB_TEST]: { branch: 'A', assigned_at: '2026-09-16T00:00:00Z' },
      },
    }
    const todoControl = {
      ...channelTreatment,
      abtests: {
        ...channelTreatment.abtests,
        [OTA_TODO_LIST_V3_AB_TEST]: { branch: 'B', assigned_at: '2026-09-16T00:00:00Z' },
      },
    }

    expect(hasNewChannelTreatment(channelTreatment)).toBe(true)
    expect(hasNewChannelTreatment(combinedTreatment)).toBe(false)
    expect(hasNewChannelTreatment(todoControl)).toBe(true)
    expect(resolveOnboardingAnalyticsVersion(channelTreatment)).toBe('5.E')
    expect(resolveOnboardingAnalyticsVersion(combinedTreatment)).toBe(4)
    expect(resolveOnboardingAnalyticsVersion(todoControl)).toBe('5.E')
  })
})
