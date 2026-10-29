// @vitest-environment happy-dom

import type { App } from 'vue'
import { createPinia, defineStore } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, nextTick, useTemplateRef, watch } from 'vue'
import { createI18n } from 'vue-i18n'
import DropdownOrganization from '../src/components/dashboard/DropdownOrganization.vue'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  route: { path: '/dashboard', params: {}, query: {} },
  organizations: [
    { gid: 'org-many-apps', name: 'Many apps', role: 'org_super_admin', is_invite: false },
    { gid: 'org-other-apps', name: 'Other apps', role: 'org_super_admin', is_invite: false },
  ],
  apps: Array.from({ length: 1000 }, (_, index) => ({
    app_id: `com.example.app${index}`,
    name: `App ${index}`,
    owner_org: 'org-many-apps',
    icon_url: `https://example.com/icon-${index}.png`,
  })),
}))

vi.mock('~/stores/organization', () => ({
  isPendingOrganizationInvite: (org: { is_invite: boolean }) => org.is_invite,
  useOrganizationStore: defineStore('switcher-test-organization', {
    state: () => ({
      organizations: mocks.organizations,
      currentOrganization: mocks.organizations[1],
    }),
    actions: {
      dedupFetchOrganizations: vi.fn(async () => undefined),
      getAppsByOrgId: (orgId: string) => orgId === 'org-many-apps' ? mocks.apps : [],
      getAppByAppId: (appId: string) => mocks.apps.find(app => app.app_id === appId),
      setCurrentOrganization(orgId: string) {
        this.currentOrganization = mocks.organizations.find(org => org.gid === orgId)!
      },
    },
  }),
}))
vi.mock('~/stores/main', () => ({ useMainStore: () => ({}) }))
vi.mock('~/stores/dialogv2', () => ({ useDialogV2Store: () => ({}) }))
vi.mock('~/services/console', () => ({ useConsole: () => ({}) }))
vi.mock('~/services/nativeCompliance', () => ({ isNativeAppStoreContext: () => false }))
vi.mock('~/services/storage', () => ({ resolveImagePath: () => ({ normalized: '' }) }))

let mountedApp: App | undefined
let container: HTMLDivElement

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('nextTick', nextTick)
  vi.stubGlobal('useTemplateRef', useTemplateRef)
  vi.stubGlobal('useRoute', () => mocks.route)
  vi.stubGlobal('useRouter', () => ({ push: mocks.push, currentRoute: { value: mocks.route } }))
  vi.stubGlobal('onClickOutside', vi.fn())
  vi.stubGlobal('onKeyStroke', vi.fn())
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  mountedApp?.unmount()
  mountedApp = undefined
  container.remove()
  vi.unstubAllGlobals()
})

async function mountSwitcher(compact = false) {
  mountedApp = createApp(DropdownOrganization, { compact })
  const pinia = createPinia()
  mountedApp.use(pinia)
  mountedApp.use(createI18n({
    legacy: false,
    locale: 'en',
    missingWarn: false,
    fallbackWarn: false,
    messages: { en: { 'view-all-apps': 'View all apps' } },
  }))
  mountedApp.mount(container)
  await nextTick()
  const dropdown = container.querySelector('details')!
  return { dropdown, pinia }
}

async function toggleDropdown(dropdown: HTMLDetailsElement, open: boolean) {
  dropdown.open = open
  dropdown.dispatchEvent(new Event('toggle'))
  await nextTick()
}

describe('organization switcher with many apps', () => {
  it.each([false, true])('does not mount the closed menu (compact: %s)', async (compact) => {
    await mountSwitcher(compact)

    expect(document.querySelector('[data-test="org-switcher-menu"]') === null).toBe(true)
    expect(document.querySelectorAll('img')).toHaveLength(0)
  })

  it.each([false, true])('bounds the list and searches every app (compact: %s)', async (compact) => {
    const { dropdown } = await mountSwitcher(compact)
    await toggleDropdown(dropdown, true)

    expect(document.querySelectorAll('button[title^="App "]')).toHaveLength(20)
    expect(document.querySelector('[data-test="org-switcher-view-all-apps"]')).not.toBeNull()

    const search = document.querySelector<HTMLInputElement>('[data-test="org-switcher-search"]')!
    search.value = 'com.example.app999'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    const matches = document.querySelectorAll<HTMLButtonElement>('button[title^="App "]')
    expect(matches).toHaveLength(1)
    expect(matches[0].title).toContain('com.example.app999')
    matches[0].click()
    await nextTick()
    expect(mocks.push).toHaveBeenCalledWith('/app/com.example.app999')
    expect(dropdown.open).toBe(false)
    expect(document.querySelector('[data-test="org-switcher-menu"]')).toBeNull()
  })

  it('unmounts the menu on native close and clears search when reopened', async () => {
    const { dropdown } = await mountSwitcher()
    await toggleDropdown(dropdown, true)
    const search = container.querySelector<HTMLInputElement>('[data-test="org-switcher-search"]')!
    search.value = 'com.example.app999'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    await toggleDropdown(dropdown, false)
    expect(container.querySelector('[data-test="org-switcher-menu"]')).toBeNull()
    await toggleDropdown(dropdown, true)
    expect(container.querySelector<HTMLInputElement>('[data-test="org-switcher-search"]')?.value).toBe('')
    expect(container.querySelectorAll('button[title^="App "]')).toHaveLength(20)
  })

  it('opens the full app list in the selected organization', async () => {
    const { dropdown, pinia } = await mountSwitcher()
    await toggleDropdown(dropdown, true)
    container.querySelector<HTMLButtonElement>('[data-test="org-switcher-view-all-apps"]')?.click()
    await nextTick()

    expect(mocks.push).toHaveBeenCalledWith('/apps')
    expect(pinia.state.value['switcher-test-organization'].currentOrganization.gid).toBe('org-many-apps')
    expect(dropdown.open).toBe(false)
  })
})
