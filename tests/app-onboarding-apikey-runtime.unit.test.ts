// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import AppOnboardingFlow from '../src/components/dashboard/AppOnboardingFlow.vue'

const runtimeMocks = vi.hoisted(() => {
  const app = {
    app_id: 'com.test.runtime-onboarding',
    name: 'Runtime onboarding app',
    owner_org: 'org-runtime-onboarding',
    existing_app: false,
    icon_url: null,
    ios_store_url: null,
    android_store_url: null,
  }

  return {
    app,
    createApp: vi.fn(async () => ({
      ok: true as const,
      app,
      usedAppId: app.app_id,
      originalAppId: app.app_id,
      wasRetried: false,
    })),
    createDefaultApiKey: vi.fn(),
    findUsablePlainApiKey: vi.fn(async () => 'runtime-api-key'),
    main: {
      auth: { id: 'user-runtime-onboarding' },
      awaitInitialLoad: vi.fn(async () => undefined),
      isAdmin: false,
      plans: [],
      user: null as { id: string, onboarding: Record<string, unknown> } | null,
    },
    organizationStore: {
      awaitInitialLoad: vi.fn(async () => undefined),
      currentOrganization: { gid: 'org-runtime-onboarding', name: 'Runtime organization' },
      organizations: [],
      updateAppOnboarding: vi.fn(),
    },
    query: {} as Record<string, string>,
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: runtimeMocks.query }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('vue-sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))
vi.mock('~/services/apikeys', () => ({
  createDefaultApiKey: runtimeMocks.createDefaultApiKey,
  findUsablePlainApiKey: runtimeMocks.findUsablePlainApiKey,
}))
vi.mock('~/services/onboardingTracking', () => ({ sendOnboardingEvent: vi.fn() }))
vi.mock('~/services/supabase', () => ({
  getLocalConfig: () => ({ supaHost: 'https://sb.capgo.app', supaKey: 'anon-key' }),
  isLocal: () => false,
  useSupabase: () => {
    const query = {
      eq: () => query,
      maybeSingle: async () => ({ data: null, error: null }),
      select: () => query,
      single: async () => ({ data: runtimeMocks.app, error: null }),
    }
    return {
      auth: { getClaims: async () => ({ data: { claims: { sub: runtimeMocks.main.auth.id } } }) },
      from: () => query,
      rpc: async () => ({ data: null, error: null }),
    }
  },
}))
vi.mock('~/stores/dashboardApps', () => ({ useDashboardAppsStore: () => ({ upsertApp: vi.fn() }) }))
vi.mock('~/stores/dialogv2', () => ({
  useDialogV2Store: () => ({
    lastButtonRole: null,
    onDialogDismiss: vi.fn(async () => undefined),
    openDialog: vi.fn(),
  }),
}))
vi.mock('~/stores/main', () => ({ useMainStore: () => runtimeMocks.main }))
vi.mock('~/stores/organization', () => ({ useOrganizationStore: () => runtimeMocks.organizationStore }))
vi.mock('~/utils/onboardingAppCreateHelpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/onboardingAppCreateHelpers')>()
  return { ...actual, createOnboardingAppWithFallbackIds: runtimeMocks.createApp }
})
vi.mock('~/utils/onboardingProgressPersistence', () => ({
  createOnboardingProgressPersistence: () => ({
    abort: vi.fn(),
    isAborted: () => false,
    isBlocked: () => false,
    persist: async () => 'persisted',
  }),
  shouldInitializeOnboardingProgressTracking: () => true,
}))

interface MountedFlow {
  app: ReturnType<typeof createApp>
  container: HTMLDivElement
}

const mountedFlows: MountedFlow[] = []

async function mountFlow(query: Record<string, string> = {}) {
  runtimeMocks.query = query
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(AppOnboardingFlow, { onboarding: false })
  app.config.warnHandler = () => undefined
  app.mount(container)
  const mounted = { app, container }
  mountedFlows.push(mounted)
  return mounted
}

function element<T extends Element>(container: Element, selector: string) {
  const value = container.querySelector<T>(selector)
  if (!value)
    throw new Error(`Missing onboarding element: ${selector}`)
  return value
}

async function click(container: Element, selector: string) {
  element<HTMLButtonElement>(container, selector).click()
  await nextTick()
}

async function reachIconStep(container: Element) {
  await vi.waitFor(() => expect(container.querySelector('[data-test="app-onboarding-name"]')).not.toBeNull())
  await click(container, '[data-test="app-onboarding-existing-no"]')

  const nameInput = element<HTMLInputElement>(container, '[data-test="app-onboarding-name"]')
  nameInput.value = 'Runtime onboarding app'
  nameInput.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()

  await click(container, '[data-test="app-onboarding-continue"]')
  await vi.waitFor(() => expect(container.querySelector('[data-test="app-onboarding-skip-app-id"]')).not.toBeNull())
  await click(container, '[data-test="app-onboarding-skip-app-id"]')
  await vi.waitFor(() => expect(container.textContent).toContain('app-onboarding-command-show'))
}

function buttonWithText(container: Element, text: string) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find(candidate => candidate.textContent?.includes(text))
  if (!button)
    throw new Error(`Missing onboarding button with text: ${text}`)
  return button
}

beforeEach(() => {
  runtimeMocks.query = {}
  runtimeMocks.createApp.mockClear()
  runtimeMocks.createDefaultApiKey.mockClear()
  runtimeMocks.findUsablePlainApiKey.mockClear()
  runtimeMocks.main.awaitInitialLoad.mockClear()
  runtimeMocks.main.user = null
  runtimeMocks.organizationStore.awaitInitialLoad.mockClear()
  runtimeMocks.organizationStore.updateAppOnboarding.mockClear()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false })),
  })
})

afterEach(() => {
  for (const mounted of mountedFlows.splice(0)) {
    mounted.app.unmount()
    mounted.container.remove()
  }
})

describe('app onboarding API key runtime loading', () => {
  it('does not provision a key when a fresh existing-org wizard is only opened', async () => {
    const { container } = await mountFlow()

    await vi.waitFor(() => expect(container.querySelector('[data-test="app-onboarding-name"]')).not.toBeNull())

    expect(runtimeMocks.findUsablePlainApiKey).not.toHaveBeenCalled()
    expect(runtimeMocks.createDefaultApiKey).not.toHaveBeenCalled()
  })

  it('loads one key for a resumed app even when the public profile is not ready', async () => {
    await mountFlow({ resume: runtimeMocks.app.app_id, step: 'choice' })

    await vi.waitFor(() => expect(runtimeMocks.findUsablePlainApiKey).toHaveBeenCalledTimes(1))

    expect(runtimeMocks.findUsablePlainApiKey).toHaveBeenCalledWith(
      expect.anything(),
      runtimeMocks.main.auth.id,
      runtimeMocks.organizationStore.currentOrganization.gid,
      runtimeMocks.app.app_id,
    )
    expect(runtimeMocks.createDefaultApiKey).not.toHaveBeenCalled()
  })

  it('loads one key when the CLI command is explicitly revealed', async () => {
    const { container } = await mountFlow()
    await reachIconStep(container)
    expect(runtimeMocks.findUsablePlainApiKey).not.toHaveBeenCalled()

    buttonWithText(container, 'app-onboarding-command-show').click()

    await vi.waitFor(() => expect(runtimeMocks.findUsablePlainApiKey).toHaveBeenCalledTimes(1))
    expect(runtimeMocks.createDefaultApiKey).not.toHaveBeenCalled()
  })

  it('loads one key when a newly created app enters the install step', async () => {
    const { container } = await mountFlow()
    await reachIconStep(container)
    expect(runtimeMocks.findUsablePlainApiKey).not.toHaveBeenCalled()

    await click(container, '[data-test="app-onboarding-continue"]')
    await vi.waitFor(() => expect(runtimeMocks.createApp).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(container.textContent).toContain('app-onboarding-choice-real-title'))
    expect(runtimeMocks.findUsablePlainApiKey).not.toHaveBeenCalled()

    buttonWithText(container, 'app-onboarding-choice-real-title').click()

    await vi.waitFor(() => expect(runtimeMocks.findUsablePlainApiKey).toHaveBeenCalledTimes(1))
    expect(runtimeMocks.createDefaultApiKey).not.toHaveBeenCalled()
  })
})
