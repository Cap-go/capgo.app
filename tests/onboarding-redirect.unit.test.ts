// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('onboarding dashboard redirect', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    window.sessionStorage.clear()
  })

  async function getRedirect(options: Parameters<(typeof import('../src/utils/onboardingRedirect.ts'))['getOnboardingResumeRedirect']>[0]) {
    const { getOnboardingResumeRedirect } = await import('../src/utils/onboardingRedirect.ts')
    return getOnboardingResumeRedirect(options)
  }

  const eligibleUser = '2026-08-03T23:00:01.000Z'

  it('redirects an eligible user with one pending app to its setup flow', async () => {
    const expectedResume = { path: '/onboarding/app', query: { resume: 'com.example.app', step: 'setup' } }
    await expect(getRedirect({
      appId: 'com.example.app',
      appCount: 1,
      createdAt: eligibleUser,
      organizationCount: 1,
      path: '/settings/account',
      resumeAppId: null,
      userId: 'user-1',
    })).resolves.toEqual(expectedResume)
    await expect(getRedirect({
      appId: 'com.example.app',
      appCount: 1,
      createdAt: eligibleUser,
      organizationCount: 1,
      path: '/dashboard',
      resumeAppId: null,
      userId: 'user-1',
    })).resolves.toEqual(expectedResume)
    await expect(getRedirect({
      appId: 'com.example.app',
      appCount: 1,
      createdAt: eligibleUser,
      organizationCount: 1,
      path: '/apps',
      resumeAppId: null,
      userId: 'user-1',
    })).resolves.toEqual(expectedResume)
  })

  it('does not redirect the resumable onboarding route or ineligible account shapes', async () => {
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/onboarding/app', resumeAppId: 'com.example.app', userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/app/new', resumeAppId: 'com.example.app', userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: 'com.example.app', appCount: 2, createdAt: eligibleUser, organizationCount: 1, path: '/apps', resumeAppId: null, userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 2, path: '/apps', resumeAppId: null, userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: null, appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/apps', resumeAppId: null, userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: '2026-08-03T23:00:00.000Z', organizationCount: 1, path: '/apps', resumeAppId: null, userId: 'user-1' })).resolves.toBeNull()
  })

  it('lets an onboarding user open their existing app, devices, and settings without a redirect', async () => {
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/app/com.example.app', resumeAppId: null, userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/app/com.example.app/device/abc', resumeAppId: null, userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/app/com.example.app/bundle/12', resumeAppId: null, userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/app/com.example.app/settings', resumeAppId: null, userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/app/com.example.app/settings/access', resumeAppId: null, userId: 'user-1' })).resolves.toBeNull()
  })

  it('keeps dashboard exploration granted after a page reload', async () => {
    const module = await import('../src/utils/onboardingRedirect.ts')
    module.allowOnboardingDashboardExploration('user-1', 'com.example.app')
    expect(module.getOnboardingResumeAppId('user-1')).toBe('com.example.app')
    expect(module.getOnboardingResumeAppId('user-2')).toBeNull()
    expect(module.getOnboardingResumeRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/apps', resumeAppId: null, userId: 'user-1' })).toBeNull()
    expect(module.getOnboardingResumeRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/apps', resumeAppId: null, userId: 'user-2' })).toEqual({ path: '/onboarding/app', query: { resume: 'com.example.app', step: 'setup' } })

    // Reloading the page drops module memory but keeps session storage.
    vi.resetModules()
    const refreshedModule = await import('../src/utils/onboardingRedirect.ts')
    expect(refreshedModule.getOnboardingResumeAppId('user-1')).toBe('com.example.app')
    expect(refreshedModule.getOnboardingResumeRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/apps', resumeAppId: null, userId: 'user-1' })).toBeNull()
  })

  it('keeps the shared exploration grant free of analytics signals', async () => {
    const module = await import('../src/utils/onboardingRedirect.ts')
    const listener = vi.fn()
    window.addEventListener(module.ONBOARDING_DASHBOARD_EXPLORED_EVENT, listener)

    module.allowOnboardingDashboardExploration('user-1', 'com.example.app')

    expect(listener).not.toHaveBeenCalled()
    window.removeEventListener(module.ONBOARDING_DASHBOARD_EXPLORED_EVENT, listener)
  })

  it('ignores a null grant so a missing user id cannot clear exploration', async () => {
    const module = await import('../src/utils/onboardingRedirect.ts')
    module.allowOnboardingDashboardExploration('user-1', 'com.example.app')
    module.allowOnboardingDashboardExploration(null, 'com.example.app')
    expect(module.getOnboardingResumeAppId('user-1')).toBe('com.example.app')
    expect(module.getOnboardingResumeRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/apps', resumeAppId: null, userId: 'user-1' })).toBeNull()
  })

  it('prefers the in-memory grant when session storage still holds another user', async () => {
    window.sessionStorage.setItem('capgo:onboarding-dashboard-exploration', JSON.stringify({
      userId: 'user-old',
      resumeAppId: 'com.old.app',
    }))
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })

    const module = await import('../src/utils/onboardingRedirect.ts')
    module.allowOnboardingDashboardExploration('user-1', 'com.example.app')
    expect(module.getOnboardingResumeAppId('user-1')).toBe('com.example.app')
    expect(module.getOnboardingResumeAppId('user-old')).toBeNull()
  })

  it('asks for dashboard confirmation only before exploration is granted', async () => {
    const module = await import('../src/utils/onboardingRedirect.ts')

    expect(module.shouldConfirmOnboardingDashboardExploration({
      destination: '/dashboard',
      resumeAppId: 'com.example.app',
      userId: 'user-1',
    })).toBe(true)

    module.allowOnboardingDashboardExploration('user-1', 'com.example.app')

    expect(module.shouldConfirmOnboardingDashboardExploration({
      destination: '/dashboard',
      resumeAppId: 'com.example.app',
      userId: 'user-1',
    })).toBe(false)
  })
})

describe('post-CLI getting started redirect', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    window.sessionStorage.clear()
  })

  it('sends a finished CLI user back to getting started from dashboard and leftover onboarding routes', async () => {
    const { getGettingStartedContinueRedirect } = await import('../src/utils/onboardingRedirect.ts')
    const options = {
      appId: 'com.example.app',
      appCount: 1,
      createdAt: '2026-08-03T23:00:01.000Z',
      ledger: { features: { cli_install: { succeeded_at: '2026-08-14T00:00:00.000Z' } } },
      needOnboarding: false,
      organizationCount: 1,
      userId: 'user-1',
    }

    expect(getGettingStartedContinueRedirect({ ...options, path: '/dashboard' })).toEqual({
      path: '/app/com.example.app/getting-started',
    })
    expect(getGettingStartedContinueRedirect({ ...options, path: '/apps' })).toEqual({
      path: '/app/com.example.app/getting-started',
    })
    expect(getGettingStartedContinueRedirect({ ...options, path: '/onboarding/app' })).toEqual({
      path: '/app/com.example.app/getting-started',
    })
    expect(getGettingStartedContinueRedirect({ ...options, path: '/app/new' })).toEqual({
      path: '/app/com.example.app/getting-started',
    })
    expect(getGettingStartedContinueRedirect({ ...options, path: '/settings/account' })).toBeNull()
    expect(getGettingStartedContinueRedirect({ ...options, path: '/dashboard', needOnboarding: true })).toBeNull()
    expect(getGettingStartedContinueRedirect({
      ...options,
      path: '/dashboard',
      extras: { cicdSetupValidated: true, storeReleaseValidated: true, cliSetupCompleted: true },
      ledger: {
        features: {
          cli_install: { succeeded_at: '2026-08-14T00:00:00.000Z' },
          ota: { succeeded_at: '2026-08-14T00:00:00.000Z', stage: 'store_live' },
        },
      },
    })).toBeNull()
  })
})
