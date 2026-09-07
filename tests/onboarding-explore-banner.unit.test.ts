import { describe, expect, it } from 'vitest'
import { getOnboardingExploreBannerAppId } from '../src/utils/onboardingRedirect'

describe('onboarding exploration banner', () => {
  it.concurrent('shows only for one organization with one pending onboarding app', () => {
    expect(getOnboardingExploreBannerAppId({
      app: { app_id: 'com.example.pending', need_onboarding: true },
      organizationAppCount: 1,
      organizationCount: 1,
    })).toBe('com.example.pending')

    expect(getOnboardingExploreBannerAppId({
      app: { app_id: 'com.example.ready', need_onboarding: false },
      organizationAppCount: 1,
      organizationCount: 1,
    })).toBeNull()

    expect(getOnboardingExploreBannerAppId({
      app: { app_id: 'com.example.pending', need_onboarding: true },
      organizationAppCount: 2,
      organizationCount: 1,
    })).toBeNull()

    expect(getOnboardingExploreBannerAppId({
      app: { app_id: 'com.example.pending', need_onboarding: true },
      organizationAppCount: 1,
      organizationCount: 2,
    })).toBeNull()

    expect(getOnboardingExploreBannerAppId({
      app: null,
      organizationAppCount: 1,
      organizationCount: 1,
    })).toBeNull()

    expect(getOnboardingExploreBannerAppId({
      app: {
        app_id: 'com.example.pending',
        need_onboarding: true,
        onboarding: { setup: { outcome: 'completed' } },
      },
      organizationAppCount: 1,
      organizationCount: 1,
    })).toBeNull()
  })
})
