// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('onboarding dashboard redirect', () => {
  beforeEach(() => {
    vi.resetModules()
    window.sessionStorage.clear()
  })

  async function getRedirect(options: Parameters<(typeof import('../src/utils/onboardingRedirect.ts'))['getOnboardingResumeRedirect']>[0]) {
    const { getOnboardingResumeRedirect } = await import('../src/utils/onboardingRedirect.ts')
    return getOnboardingResumeRedirect(options)
  }

  const eligibleUser = '2026-08-03T23:00:01.000Z'

  it('redirects an eligible user with one pending app to its setup flow', async () => {
    await expect(getRedirect({
      appId: 'com.example.app',
      appCount: 1,
      createdAt: eligibleUser,
      organizationCount: 1,
      path: '/settings/account',
      resumeAppId: null,
      userId: 'user-1',
    })).resolves.toEqual({ path: '/app/new', query: { resume: 'com.example.app' } })
  })

  it('does not redirect the resumable onboarding route or ineligible account shapes', async () => {
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/app/new', resumeAppId: 'com.example.app', userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: 'com.example.app', appCount: 2, createdAt: eligibleUser, organizationCount: 1, path: '/apps', resumeAppId: null, userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 2, path: '/apps', resumeAppId: null, userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: null, appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/apps', resumeAppId: null, userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: '2026-08-03T23:00:00.000Z', organizationCount: 1, path: '/apps', resumeAppId: null, userId: 'user-1' })).resolves.toBeNull()
  })

  it('lets an onboarding user open the app settings pages without a redirect', async () => {
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/app/com.example.app/settings', resumeAppId: null, userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/app/com.example.app/settings/access', resumeAppId: null, userId: 'user-1' })).resolves.toBeNull()
  })

  it('keeps dashboard exploration granted after a page reload', async () => {
    const module = await import('../src/utils/onboardingRedirect.ts')
    module.allowOnboardingDashboardExploration('user-1', 'com.example.app')
    expect(module.getOnboardingResumeAppId('user-1')).toBe('com.example.app')
    expect(module.getOnboardingResumeAppId('user-2')).toBeNull()
    expect(module.getOnboardingResumeRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/apps', resumeAppId: null, userId: 'user-1' })).toBeNull()
    expect(module.getOnboardingResumeRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/apps', resumeAppId: null, userId: 'user-2' })).toEqual({ path: '/app/new', query: { resume: 'com.example.app' } })

    // Reloading the page drops module memory but keeps session storage.
    vi.resetModules()
    const refreshedModule = await import('../src/utils/onboardingRedirect.ts')
    expect(refreshedModule.getOnboardingResumeAppId('user-1')).toBe('com.example.app')
    expect(refreshedModule.getOnboardingResumeRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/apps', resumeAppId: null, userId: 'user-1' })).toBeNull()
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
