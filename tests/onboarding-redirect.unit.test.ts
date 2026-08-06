import { beforeEach, describe, expect, it, vi } from 'vitest'

function stubSessionStorage() {
  const storage = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    removeItem: vi.fn((key: string) => storage.delete(key)),
    setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    clear: vi.fn(() => storage.clear()),
  })
}

describe('onboarding dashboard redirect', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    stubSessionStorage()
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

  it('scopes the exploration grant to the granted user', async () => {
    const module = await import('../src/utils/onboardingRedirect.ts')
    module.allowOnboardingDashboardExploration('user-1', 'com.example.app')
    expect(module.getOnboardingResumeAppId('user-1')).toBe('com.example.app')
    expect(module.getOnboardingResumeAppId('user-2')).toBeNull()
    expect(module.getOnboardingResumeRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/apps', resumeAppId: null, userId: 'user-1' })).toBeNull()
    expect(module.getOnboardingResumeRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/apps', resumeAppId: null, userId: 'user-2' })).toEqual({ path: '/app/new', query: { resume: 'com.example.app' } })
  })

  it('keeps the exploration grant after a full page reload', async () => {
    const module = await import('../src/utils/onboardingRedirect.ts')
    module.allowOnboardingDashboardExploration('user-1', 'com.example.app')

    // A reload re-imports the module fresh; the grant must survive because it
    // is persisted in sessionStorage rather than module-level state.
    vi.resetModules()
    const refreshedModule = await import('../src/utils/onboardingRedirect.ts')
    expect(refreshedModule.canExploreOnboardingDashboard('user-1')).toBe(true)
    expect(refreshedModule.getOnboardingResumeAppId('user-1')).toBe('com.example.app')
    expect(refreshedModule.getOnboardingResumeRedirect({ appId: 'com.example.app', appCount: 1, createdAt: eligibleUser, organizationCount: 1, path: '/apps', resumeAppId: null, userId: 'user-1' })).toBeNull()
  })

  it('falls back to in-memory state when sessionStorage is unavailable', async () => {
    vi.stubGlobal('sessionStorage', undefined)
    const module = await import('../src/utils/onboardingRedirect.ts')
    expect(module.canExploreOnboardingDashboard('user-1')).toBe(false)
    expect(() => module.allowOnboardingDashboardExploration('user-1', 'com.example.app')).not.toThrow()
    // Without storage the grant still works within the current runtime rather
    // than failing closed and stranding the user in the redirect loop.
    expect(module.canExploreOnboardingDashboard('user-1')).toBe(true)
    expect(module.getOnboardingResumeAppId('user-1')).toBe('com.example.app')
  })
})
