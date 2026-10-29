// @vitest-environment happy-dom

import type { App } from 'vue'
import { createPinia } from 'pinia'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, nextTick, reactive, ref, watch } from 'vue'
import { createI18n } from 'vue-i18n'
import AppSetting from '../src/components/dashboard/AppSetting.vue'
import { useDashboardAppsStore } from '../src/stores/dashboardApps'

const mocks = vi.hoisted(() => ({
  deleteApp: vi.fn(),
  push: vi.fn(),
  fetchOrganizations: vi.fn(),
  apps: [{ app_id: 'com.example.deleting', name: 'Example' }],
}))
vi.mock('~/services/console', () => ({
  useConsole: () => ({
    storage: { from: () => ({ remove: async () => ({ error: null }) }) },
    from: () => ({
      delete: () => ({ eq: () => mocks.deleteApp() }),
      select: () => ({ eq: () => ({ order: () => ({ range: async () => ({ data: mocks.apps, error: null }) }) }) }),
    }),
  }),
}))
vi.mock('~/stores/organization', () => ({ useOrganizationStore: () => ({
  currentOrganization: { gid: 'org-example' },
  dedupFetchOrganizations: async () => undefined,
  fetchOrganizations: mocks.fetchOrganizations,
  getOrgByAppId: () => ({ gid: 'org-example' }),
}) }))
vi.mock('~/stores/display', () => ({ useDisplayStore: () => ({ setAppNameResolver: vi.fn() }) }))
vi.mock('~/stores/dialogv2', () => ({ useDialogV2Store: () => ({ closeDialog: vi.fn() }) }))
vi.mock('~/services/onboardingTracking', () => ({ sendOnboardingEvent: vi.fn() }))
vi.mock('~/services/permissions', () => ({ checkPermissions: async () => true }))
vi.mock('~/services/capgoApi', () => ({ invokeCapgoApi: vi.fn() }))
vi.mock('~/services/storage', () => ({ createSignedImageUrl: vi.fn(), getImmediateImageUrl: vi.fn() }))

let mounted: App | undefined

beforeEach(() => {
  vi.clearAllMocks()
  mocks.apps = [{ app_id: 'com.example.deleting', name: 'Example' }]
  mocks.deleteApp.mockImplementation(async () => {
    mocks.apps = []
    return { error: null }
  })
  for (const [name, value] of Object.entries({ computed, ref, reactive, watch }))
    vi.stubGlobal(name, value)
  vi.stubGlobal('onMounted', vi.fn())
  vi.stubGlobal('useRouter', () => ({ push: mocks.push }))
  vi.stubGlobal('useRoute', () => ({ hash: '' }))
  vi.stubGlobal('useOrganizationStore', () => ({
    getOrgByAppId: () => ({ gid: 'org-example' }),
    fetchOrganizations: mocks.fetchOrganizations,
  }))
})

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  vi.unstubAllGlobals()
})

async function mountSettings() {
  const pinia = createPinia()
  const catalog = useDashboardAppsStore(pinia)
  await catalog.fetchApps()
  mounted = createApp({ ...AppSetting, render: () => null }, { appId: 'com.example.deleting' })
  mounted.use(pinia)
  mounted.use(createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false, messages: { en: {} } }))
  const instance = mounted.mount(document.createElement('div'))
  await nextTick()
  const settings: unknown = Reflect.get(instance.$, 'setupState')
  assert(settings && typeof settings === 'object')
  assert('deletionConfirmation' in settings && 'deleteApp' in settings && typeof settings.deleteApp === 'function')
  settings.deletionConfirmation = 'com.example.deleting'
  return { catalog, deleteApp: settings.deleteApp }
}

describe('app settings catalog invalidation', () => {
  it('revalidates the shared dashboard catalog after deleting the last app', async () => {
    const { catalog, deleteApp } = await mountSettings()
    await deleteApp()
    await catalog.fetchApps()

    expect(catalog.apps).toEqual([])
    expect(catalog.isLoaded).toBe(true)
    expect(mocks.push).toHaveBeenCalledWith('/apps')
  })

  it('keeps the shared catalog if the app deletion fails', async () => {
    const { catalog, deleteApp } = await mountSettings()
    mocks.deleteApp.mockResolvedValueOnce({ error: { message: 'Deletion failed' } })
    await deleteApp()

    expect(catalog.appIds).toEqual(['com.example.deleting'])
    expect(catalog.isLoaded).toBe(true)
    expect(mocks.deleteApp).toHaveBeenCalledOnce()
    expect(mocks.fetchOrganizations).not.toHaveBeenCalled()
  })
})
