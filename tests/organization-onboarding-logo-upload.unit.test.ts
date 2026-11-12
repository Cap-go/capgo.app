// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive, ref, toRef } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import OrganizationOnboarding from '../src/pages/onboarding/organization.vue'

const mocks = vi.hoisted(() => ({
  invokeCapgoApi: vi.fn(async (path: string) => path === 'private/website_preview'
    ? { data: { hostname: 'example.com', name: 'Example', icon: 'data:image/png;base64,AA==', website: 'https://example.com' }, error: null }
    : { data: { id: 'org-created' }, error: null }),
  uploadOrgLogoFile: vi.fn().mockRejectedValue(new Error('storage failed')),
  replace: vi.fn(async () => undefined),
  fetchOrganizations: vi.fn(async (): Promise<void> => undefined),
  loadOnboardingAppDraft: vi.fn((): { appName: string, appId: string } | null => ({ appName: 'Example App', appId: 'com.example.app' })),
}))

vi.mock('pinia', () => ({ storeToRefs: (store: any) => ({ currentOrganization: toRef(store, 'currentOrganization') }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('vue-sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))
vi.mock('~/components/dashboard/InviteTeammateModal.vue', () => ({ default: { template: '<div />' } }))
vi.mock('~/components/dashboard/OnboardingSupportUsernames.vue', () => ({ default: { template: '<div />' } }))
vi.mock('~/components/dashboard/BillingRegionChoice.vue', () => ({ default: { template: '<div />' } }))
vi.mock('~/services/capgoApi', () => ({ getCapgoApiErrorCode: vi.fn(), invokeCapgoApi: mocks.invokeCapgoApi }))
vi.mock('~/services/formatLocale', () => ({ formatNumberValue: (value: number) => String(value) }))
vi.mock('~/services/onboardingAppCreate', () => ({ createOnboardingAppFromDraft: vi.fn() }))
vi.mock('~/services/photos', () => ({ uploadOrgLogoFile: mocks.uploadOrgLogoFile }))
vi.mock('~/services/posthog', () => ({ pushEvent: vi.fn() }))
vi.mock('~/services/console', () => ({
  getLocalConfig: () => ({ apiHost: 'https://api.capgo.app' }),
  isLocal: () => false,
  useConsole: () => ({}),
}))
vi.mock('~/stores/display', () => ({ useDisplayStore: () => ({ NavTitle: '', defaultBack: '' }) }))
vi.mock('~/stores/main', () => ({
  useMainStore: () => ({
    auth: { id: 'user-1', email: 'user@example.com' },
    user: { id: 'user-1', first_name: 'Example', last_name: 'User' },
    plans: [],
  }),
}))
vi.mock('~/stores/organization', () => {
  const store = reactive({ currentOrganization: null, organizations: [], fetchOrganizations: mocks.fetchOrganizations, setCurrentOrganization: vi.fn() })
  return { useOrganizationStore: () => store }
})
vi.mock('~/utils/onboardingAppDraft', () => ({
  clearOnboardingAppDraft: vi.fn(),
  loadOnboardingAppDraft: mocks.loadOnboardingAppDraft,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fetchOrganizations.mockReset().mockResolvedValue(undefined)
  mocks.loadOnboardingAppDraft.mockReset().mockReturnValue({ appName: 'Example App', appId: 'com.example.app' })
})
afterEach(() => vi.unstubAllGlobals())

async function flushPromises() {
  for (let index = 0; index < 8; index++)
    await Promise.resolve()
  await nextTick()
}

describe('organization onboarding initialization and logo import', () => {
  it('allows retry when a guard aborts the app setup redirect', async () => {
    mocks.loadOnboardingAppDraft.mockReturnValue(null)
    const history = createMemoryHistory()
    const router = createRouter({
      history,
      routes: [
        { path: '/onboarding/organization', component: { template: '<div />' } },
        { path: '/onboarding/app', component: { template: '<div />' } },
      ],
    })
    await router.push('/onboarding/organization')
    let allowNavigation = false
    router.beforeEach(() => allowNavigation)
    vi.stubGlobal('useRoute', () => router.currentRoute.value)
    vi.stubGlobal('useRouter', () => router)
    vi.stubGlobal('useTemplateRef', () => ref(null))
    const container = document.createElement('div')
    const app = createApp(OrganizationOnboarding)
    app.config.warnHandler = () => undefined
    app.mount(container)
    try {
      await vi.waitFor(() => {
        expect(container.querySelector('[data-test="onboarding-organization-load-error"]')).not.toBeNull()
      })
      expect(router.currentRoute.value.path).toBe('/onboarding/organization')

      container.querySelector<HTMLButtonElement>('[data-test="onboarding-organization-retry"]')!.click()
      await nextTick()
      expect(container.querySelector('[data-test="onboarding-organization-load-error"]')).toBeNull()
      await vi.waitFor(() => {
        expect(container.querySelector('[data-test="onboarding-organization-load-error"]')).not.toBeNull()
      })
      expect(mocks.fetchOrganizations).toHaveBeenCalledTimes(2)
      expect(router.currentRoute.value.path).toBe('/onboarding/organization')

      allowNavigation = true
      container.querySelector<HTMLButtonElement>('[data-test="onboarding-organization-retry"]')!.click()
      await vi.waitFor(() => {
        expect(router.currentRoute.value.path).toBe('/onboarding/app')
      })
      expect(container.querySelector('[data-test="onboarding-organization-load-error"]')).toBeNull()
      expect(mocks.fetchOrganizations).toHaveBeenCalledTimes(3)
      expect(mocks.invokeCapgoApi).not.toHaveBeenCalled()
    }
    finally {
      app.unmount()
      history.destroy()
    }
  })

  it.each([
    { pendingFetch: 1, failures: 0 },
    { pendingFetch: 2, failures: 0 },
    { pendingFetch: 1, failures: 1 },
    { pendingFetch: 2, failures: 1 },
    { pendingFetch: 1, failures: 2 },
    { pendingFetch: 2, failures: 2 },
  ])('waits for fetch $pendingFetch after $failures failures before allowing creation', async ({ pendingFetch, failures }) => {
    let finishInitialization!: () => void
    const pending = new Promise<void>((resolve) => {
      finishInitialization = resolve
    })
    for (let attempt = 0; attempt <= failures; attempt++) {
      for (let index = 1; index < pendingFetch; index++)
        mocks.fetchOrganizations.mockResolvedValueOnce(undefined)
      if (attempt < failures)
        mocks.fetchOrganizations.mockRejectedValueOnce(new Error('Organization fetch failed'))
    }
    mocks.fetchOrganizations.mockReturnValueOnce(pending)

    const route = reactive({ query: { source: 'org-switcher' } as Record<string, string> })
    vi.stubGlobal('useRoute', () => route)
    vi.stubGlobal('useRouter', () => ({
      back: vi.fn(),
      push: vi.fn(),
      replace: async (location: { query: Record<string, string> }) => {
        mocks.replace()
        route.query = location.query
        await nextTick()
      },
    }))
    vi.stubGlobal('useTemplateRef', () => ref(null))
    const container = document.createElement('div')
    const app = createApp(OrganizationOnboarding)
    app.config.warnHandler = () => undefined
    const unhandledError = vi.fn()
    app.config.errorHandler = unhandledError
    app.mount(container)
    try {
      await flushPromises()
      expect(mocks.fetchOrganizations).toHaveBeenCalledTimes(pendingFetch)
      container.querySelector<HTMLElement>('[data-test="onboarding-intent-ota"]')!.click()
      await nextTick()
      container.querySelector<HTMLElement>('[data-test="onboarding-mode-name"]')!.click()
      await nextTick()
      const name = container.querySelector<HTMLInputElement>('[data-test="onboarding-org-name"]')!
      name.value = 'Example Company'
      name.dispatchEvent(new Event('input', { bubbles: true }))
      container.querySelector<HTMLInputElement>('[data-test="onboarding-estimated-users-option"] input')!
        .dispatchEvent(new Event('change', { bubbles: true }))
      await nextTick()

      const create = container.querySelector<HTMLButtonElement>('[data-test="onboarding-create-org"]')!
      expect(create.disabled).toBe(true)
      create.click()
      await flushPromises()
      expect(mocks.invokeCapgoApi).not.toHaveBeenCalled()

      for (let attempt = 0; attempt < failures; attempt++) {
        const error = container.querySelector('[data-test="onboarding-organization-load-error"]')
        expect(error?.getAttribute('role')).toBe('alert')
        expect(error?.textContent).toContain('organization-onboarding-load-failed')
        const retry = container.querySelector<HTMLButtonElement>('[data-test="onboarding-organization-retry"]')!
        retry.click()
        retry.click()
        await flushPromises()
        expect(mocks.fetchOrganizations).toHaveBeenCalledTimes((attempt + 2) * pendingFetch)
        expect(create.disabled).toBe(true)
        expect(mocks.invokeCapgoApi).not.toHaveBeenCalled()
      }
      expect(container.querySelector('[data-test="onboarding-organization-load-error"]')).toBeNull()
      expect(unhandledError).not.toHaveBeenCalled()

      finishInitialization()
      await flushPromises()
      expect(create.disabled).toBe(false)
      create.click()
      await flushPromises()

      expect(mocks.invokeCapgoApi.mock.calls.filter(([path]) => path === 'organization')).toHaveLength(1)
      expect(route.query).toMatchObject({ org: 'org-created', step: 'logo' })
      expect(container.querySelector('[data-test="onboarding-logo-action"]')).not.toBeNull()
    }
    finally {
      finishInitialization()
      await flushPromises()
      app.unmount()
    }
  })

  it('keeps the created organization and opens manual logo setup when upload fails', async () => {
    vi.stubGlobal('useRoute', () => ({ query: {} }))
    vi.stubGlobal('useRouter', () => ({ back: vi.fn(), push: vi.fn(), replace: mocks.replace }))
    vi.stubGlobal('useTemplateRef', () => ref(null))
    const container = document.createElement('div')
    const app = createApp(OrganizationOnboarding)
    app.config.warnHandler = () => undefined
    app.mount(container)
    await flushPromises()

    container.querySelector<HTMLElement>('[data-test="onboarding-intent-ota"]')!.click()
    await nextTick()
    container.querySelector<HTMLElement>('[data-test="onboarding-mode-website"]')!.click()
    await nextTick()
    const website = container.querySelector<HTMLInputElement>('[data-test="onboarding-website"]')!
    website.value = 'https://example.com'
    website.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    container.querySelector<HTMLElement>('[data-test="onboarding-import-website"]')!.click()
    await flushPromises()
    container.querySelector<HTMLInputElement>('[data-test="onboarding-estimated-users-option"] input')!
      .dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    container.querySelector<HTMLElement>('[data-test="onboarding-create-org"]')!.click()
    await flushPromises()

    expect(mocks.invokeCapgoApi.mock.calls.filter(([path]) => path === 'organization')).toHaveLength(1)
    expect(mocks.uploadOrgLogoFile).toHaveBeenCalledOnce()
    expect(mocks.replace).toHaveBeenCalledWith(expect.objectContaining({ query: expect.objectContaining({ org: 'org-created', step: 'logo' }) }))
    expect(container.querySelector('[data-test="onboarding-upload-logo"]')).not.toBeNull()
    app.unmount()
  })
})
