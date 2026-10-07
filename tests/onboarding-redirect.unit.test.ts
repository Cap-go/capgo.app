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
    const expectedResume = { path: '/app/com.example.app/getting-started' }
    await expect(getRedirect({
      appId: 'com.example.app',
      appCount: 1,
      createdAt: eligibleUser,
      organizationCount: 1,
      path: '/settings/account',
      userId: 'user-1',
    })).resolves.toEqual(expectedResume)
    await expect(getRedirect({
      appId: 'com.example.app',
      appCount: 1,
      createdAt: eligibleUser,
      organizationCount: 1,
      path: '/dashboard',
      userId: 'user-1',
    })).resolves.toEqual(expectedResume)
    await expect(getRedirect({
      appId: 'com.example.app',
      appCount: 1,
      createdAt: eligibleUser,
      organizationCount: 1,
      path: '/apps',
      userId: 'user-1',
    })).resolves.toEqual(expectedResume)
  })

  it('does not redirect Getting started or ineligible account shapes', async () => {
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/app/com.example.app/getting-started', userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: 'com.example.app', appCount: 2, createdAt: eligibleUser, organizationCount: 1, path: '/apps', userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 2, path: '/apps', userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: null, appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/apps', userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: '2026-08-03T23:00:00.000Z', organizationCount: 1, path: '/apps', userId: 'user-1' })).resolves.toBeNull()
  })

  it('lets an onboarding user open their existing app, devices, and settings without a redirect', async () => {
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/app/com.example.app', userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/app/com.example.app/device/abc', userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/app/com.example.app/bundle/12', userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/app/com.example.app/settings', userId: 'user-1' })).resolves.toBeNull()
    await expect(getRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/app/com.example.app/settings/access', userId: 'user-1' })).resolves.toBeNull()
  })

  it('keeps dashboard exploration granted after a page reload', async () => {
    const module = await import('../src/utils/onboardingRedirect.ts')
    module.allowOnboardingDashboardExploration('user-1', 'com.example.app')
    expect(module.getOnboardingResumeAppId('user-1')).toBe('com.example.app')
    expect(module.getOnboardingResumeAppId('user-2')).toBeNull()
    expect(module.getOnboardingResumeRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/apps', userId: 'user-1' })).toBeNull()
    expect(module.getOnboardingResumeRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/apps', userId: 'user-2' })).toEqual({ path: '/app/com.example.app/getting-started' })

    // Reloading the page drops module memory but keeps session storage.
    vi.resetModules()
    const refreshedModule = await import('../src/utils/onboardingRedirect.ts')
    expect(refreshedModule.getOnboardingResumeAppId('user-1')).toBe('com.example.app')
    expect(refreshedModule.getOnboardingResumeRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/apps', userId: 'user-1' })).toBeNull()
  })

  it('keeps dashboard exploration granted after a new login in the same browser', async () => {
    const module = await import('../src/utils/onboardingRedirect.ts')
    module.allowOnboardingDashboardExploration('user-1', 'com.example.app')
    expect(window.localStorage.getItem('capgo:onboarding-dashboard-exploration')).toContain('user-1')

    vi.resetModules()
    window.sessionStorage.clear()
    const refreshedModule = await import('../src/utils/onboardingRedirect.ts')
    expect(refreshedModule.getOnboardingResumeRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/apps', userId: 'user-1' })).toBeNull()
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
    expect(module.getOnboardingResumeRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/apps', userId: 'user-1' })).toBeNull()
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

  it('reads a creation handoff only for the matching app', async () => {
    const { ONBOARDING_SETUP_HANDOFF_STATE_KEY, readOnboardingSetupHandoff } = await import('../src/utils/onboardingRedirect')
    const handoff = { appId: 'com.example.app', attemptId: 'attempt', flow: 'pre_org', previousStep: 'organization', runId: 'ir_run' }
    expect(readOnboardingSetupHandoff({ [ONBOARDING_SETUP_HANDOFF_STATE_KEY]: handoff }, 'com.example.app')).toEqual(handoff)
    expect(readOnboardingSetupHandoff({ [ONBOARDING_SETUP_HANDOFF_STATE_KEY]: handoff }, 'com.other.app')).toBeNull()
    expect(readOnboardingSetupHandoff({ [ONBOARDING_SETUP_HANDOFF_STATE_KEY]: { ...handoff, flow: 'unknown' } }, 'com.example.app')).toBeNull()
    expect(readOnboardingSetupHandoff(null, 'com.example.app')).toBeNull()
  })
})
