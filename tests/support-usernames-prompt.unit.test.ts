import { describe, expect, it } from 'vitest'
import { isOnboardingOrganizationSet } from '../src/services/supportUsernamesPrompt'

describe('support usernames prompt onboarding guard', () => {
  it('treats one organization with zero or one app as onboarding', () => {
    expect(isOnboardingOrganizationSet([{ app_count: 0 }])).toBe(true)
    expect(isOnboardingOrganizationSet([{ app_count: 1 }])).toBe(true)
  })

  it('allows the prompt after onboarding has progressed', () => {
    expect(isOnboardingOrganizationSet([{ app_count: 2 }])).toBe(false)
    expect(isOnboardingOrganizationSet([{ app_count: 0 }, { app_count: 0 }])).toBe(false)
  })
})
