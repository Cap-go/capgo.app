import { describe, expect, it } from 'vitest'
import { getOnboardingExploreBannerAppId } from '../src/utils/onboardingRedirect'

describe('onboarding exploration banner', () => {
  it.concurrent('shows only for one organization with one pending onboarding app', () => {
    expect(getOnboardingExploreBannerAppId({
      apps: [{ app_id: 'com.example.pending', need_onboarding: true }],
      organizationCount: 1,
    })).toBe('com.example.pending')

    expect(getOnboardingExploreBannerAppId({
      apps: [{ app_id: 'com.example.ready', need_onboarding: false }],
      organizationCount: 1,
    })).toBeNull()

    expect(getOnboardingExploreBannerAppId({
      apps: [
        { app_id: 'com.example.ready', need_onboarding: false },
        { app_id: 'com.example.pending', need_onboarding: true },
      ],
      organizationCount: 1,
    })).toBeNull()

    expect(getOnboardingExploreBannerAppId({
      apps: [{ app_id: 'com.example.pending', need_onboarding: true }],
      organizationCount: 2,
    })).toBeNull()
  })
})
