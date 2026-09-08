// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('onboarding dashboard redirect', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    window.sessionStorage.clear()
    window.localStorage.clear()
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

  it('keeps dashboard exploration granted after a new login in the same browser', async () => {
    const module = await import('../src/utils/onboardingRedirect.ts')
    module.allowOnboardingDashboardExploration('user-1', 'com.example.app')
    expect(window.localStorage.getItem('capgo:onboarding-dashboard-exploration')).toContain('user-1')

    vi.resetModules()
    window.sessionStorage.clear()
    const refreshedModule = await import('../src/utils/onboardingRedirect.ts')
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

  it('confirms console escapes during pre-create onboarding even without resumeAppId', async () => {
    const module = await import('../src/utils/onboardingRedirect.ts')

    expect(module.shouldConfirmOnboardingDashboardExploration({
      currentPath: '/app/new',
      destination: '/dashboard',
      resumeAppId: null,
      userId: 'user-1',
    })).toBe(true)

    expect(module.shouldConfirmOnboardingDashboardExploration({
      currentPath: '/app/new',
      destination: '/apps',
      resumeAppId: null,
      userId: 'user-1',
    })).toBe(true)

    expect(module.shouldConfirmOnboardingDashboardExploration({
      currentPath: '/app/new',
      destination: '#',
      resumeAppId: null,
      userId: 'user-1',
    })).toBe(false)

    expect(module.shouldConfirmOnboardingDashboardExploration({
      currentPath: '/apps',
      destination: '/dashboard',
      resumeAppId: null,
      userId: 'user-1',
    })).toBe(false)

    expect(module.shouldConfirmOnboardingDashboardExploration({
      currentPath: '/onboarding/organization',
      destination: '/dashboard',
      resumeAppId: null,
      userId: 'user-1',
    })).toBe(false)

    expect(module.shouldConfirmOnboardingDashboardExploration({
      currentPath: '/onboarding/app',
      destination: '/dashboard',
      resumeAppId: null,
      userId: 'user-1',
    })).toBe(true)

    module.allowOnboardingDashboardExploration('user-1', null)

    expect(module.shouldConfirmOnboardingDashboardExploration({
      currentPath: '/app/new',
      destination: '/dashboard',
      resumeAppId: null,
      userId: 'user-1',
    })).toBe(false)
  })
})

describe('exploration refresh reminder and v3 setup routing', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    window.sessionStorage.clear()
    window.localStorage.clear()
  })

  it('shows only on refresh of a saved exploration, once per page', async () => {
    const initial = await import('../src/utils/onboardingRedirect')
    initial.allowOnboardingDashboardExploration('user-1', 'com.example.app')
    const options = { userId: 'user-1', appId: 'com.example.app', navigationType: 'reload' }
    expect(initial.shouldShowOnboardingExplorationReminder(options)).toBe(false)
    vi.resetModules()
    const refreshed = await import('../src/utils/onboardingRedirect')
    expect(refreshed.shouldShowOnboardingExplorationReminder({ ...options, navigationType: 'navigate' })).toBe(false)
    expect(refreshed.shouldShowOnboardingExplorationReminder({ ...options, userId: 'user-2' })).toBe(false)
    expect(refreshed.shouldShowOnboardingExplorationReminder({ ...options, appId: 'com.other.app' })).toBe(false)
    expect(refreshed.shouldShowOnboardingExplorationReminder(options)).toBe(true)
    refreshed.markOnboardingExplorationReminderShown()
    expect(refreshed.shouldShowOnboardingExplorationReminder(options)).toBe(false)
  })

  it('persists reminder dismissal without clearing exploration or dismissing another user', async () => {
    const initial = await import('../src/utils/onboardingRedirect')
    initial.allowOnboardingDashboardExploration('user-1', 'com.example.app')
    initial.dismissOnboardingExplorationReminder('user-1')
    vi.resetModules()
    const refreshed = await import('../src/utils/onboardingRedirect')
    expect(refreshed.shouldShowOnboardingExplorationReminder({ userId: 'user-1', appId: 'com.example.app', navigationType: 'reload' })).toBe(false)
    expect(refreshed.getOnboardingResumeAppId('user-1')).toBe('com.example.app')
    refreshed.allowOnboardingDashboardExploration('user-2', 'com.example.app')
    vi.resetModules()
    const other = await import('../src/utils/onboardingRedirect')
    expect(other.shouldShowOnboardingExplorationReminder({ userId: 'user-2', appId: 'com.example.app', navigationType: 'reload' })).toBe(true)
  })

  it('keeps navigation usable with blocked local storage', async () => {
    const initial = await import('../src/utils/onboardingRedirect')
    initial.allowOnboardingDashboardExploration('user-1', 'com.example.app')
    vi.resetModules()
    const refreshed = await import('../src/utils/onboardingRedirect')
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => refreshed.dismissOnboardingExplorationReminder('user-1')).not.toThrow()
  })

  it('uses fullscreen setup for v3 and v4 with no exploration grant and preserves legacy routes', async () => {
    const { getAppSetupRedirect } = await import('../src/utils/onboardingRedirect')
    for (const version of [3, 4])
      expect(getAppSetupRedirect({ app_id: 'com.example.app', onboarding: { setup: { todo_list_version: version, ...(version === 4 ? { ota_todo_list_version: '1' } : {}) } } })).toEqual({ path: '/onboarding/app', query: { resume: 'com.example.app', step: 'setup' } })
    expect(getAppSetupRedirect({ app_id: 'com.example.app', onboarding: { setup: { todo_list_version: 4, ota_todo_list_version: '2' } } })).toBeNull()
    for (const version of [1, 2])
      expect(getAppSetupRedirect({ app_id: 'com.example.app', onboarding: { setup: { todo_list_version: version } } })).toBeNull()
  })
})
