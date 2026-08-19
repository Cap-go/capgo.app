// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive, ref, toRef } from 'vue'
import OrganizationOnboarding from '../src/pages/onboarding/organization.vue'

const mocks = vi.hoisted(() => ({
  invokeCapgoApi: vi.fn(async (path: string) => path === 'private/website_preview'
    ? { data: { hostname: 'example.com', name: 'Example', icon: 'data:image/png;base64,AA==', website: 'https://example.com' }, error: null }
    : { data: { id: 'org-created' }, error: null }),
  uploadOrgLogoFile: vi.fn().mockRejectedValue(new Error('storage failed')),
  replace: vi.fn(async () => undefined),
}))

vi.mock('pinia', () => ({ storeToRefs: (store: any) => ({ currentOrganization: toRef(store, 'currentOrganization') }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('vue-sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))
vi.mock('~/components/dashboard/InviteTeammateModal.vue', () => ({ default: { template: '<div />' } }))
vi.mock('~/components/dashboard/OnboardingSupportUsernames.vue', () => ({ default: { template: '<div />' } }))
vi.mock('~/services/capgoApi', () => ({ getCapgoApiErrorCode: vi.fn(), invokeCapgoApi: mocks.invokeCapgoApi }))
vi.mock('~/services/formatLocale', () => ({ formatNumberValue: (value: number) => String(value) }))
vi.mock('~/services/onboardingAppCreate', () => ({ createOnboardingAppFromDraft: vi.fn() }))
vi.mock('~/services/photos', () => ({ uploadOrgLogoFile: mocks.uploadOrgLogoFile }))
vi.mock('~/services/posthog', () => ({ pushEvent: vi.fn() }))
vi.mock('~/services/supabase', () => ({
  getLocalConfig: () => ({ supaHost: 'https://sb.capgo.app' }),
  isLocal: () => false,
  useSupabase: () => ({}),
}))
vi.mock('~/stores/display', () => ({ useDisplayStore: () => ({ NavTitle: '', defaultBack: '' }) }))
vi.mock('~/stores/main', () => ({ useMainStore: () => ({ auth: { id: 'user-1', email: 'user@example.com' }, plans: [] }) }))
vi.mock('~/stores/organization', () => {
  const store = reactive({ currentOrganization: null, organizations: [], fetchOrganizations: vi.fn(), setCurrentOrganization: vi.fn() })
  return { useOrganizationStore: () => store }
})
vi.mock('~/utils/onboardingAppDraft', () => ({
  clearOnboardingAppDraft: vi.fn(),
  loadOnboardingAppDraft: () => ({ appName: 'Example App', appId: 'com.example.app' }),
}))

afterEach(() => vi.unstubAllGlobals())

async function flushPromises() {
  for (let index = 0; index < 8; index++)
    await Promise.resolve()
  await nextTick()
}

describe('organization onboarding logo import', () => {
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
