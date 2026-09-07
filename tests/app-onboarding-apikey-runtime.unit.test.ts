// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
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
    findUsablePlainApiKey: vi.fn(async (): Promise<string | null> => 'runtime-api-key'),
    main: {
      auth: { id: 'user-runtime-onboarding' },
      awaitInitialLoad: vi.fn(async () => undefined),
      isAdmin: false,
      plans: [],
      user: { id: 'user-runtime-onboarding', onboarding: {} } as { id: string, onboarding: Record<string, unknown> } | null,
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
vi.mock('~/services/apikeys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/apikeys')>()
  return {
    ...actual,
    createDefaultApiKey: runtimeMocks.createDefaultApiKey,
    findUsablePlainApiKey: runtimeMocks.findUsablePlainApiKey,
  }
})
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

beforeEach(() => {
  runtimeMocks.query = {}
  runtimeMocks.createApp.mockClear()
  runtimeMocks.createDefaultApiKey.mockClear()
  runtimeMocks.createDefaultApiKey.mockResolvedValue({ data: { key: 'runtime-created-api-key' }, error: null })
  runtimeMocks.findUsablePlainApiKey.mockClear()
  runtimeMocks.findUsablePlainApiKey.mockResolvedValue('runtime-api-key')
  runtimeMocks.main.awaitInitialLoad.mockClear()
  runtimeMocks.main.user = { id: runtimeMocks.main.auth.id, onboarding: {} }
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
  it('reuses a key when a fresh existing-org wizard is opened', async () => {
    const { container } = await mountFlow()

    await vi.waitFor(() => expect(container.querySelector('[data-test="app-onboarding-name"]')).not.toBeNull())
    await vi.waitFor(() => expect(runtimeMocks.findUsablePlainApiKey).toHaveBeenCalledTimes(1))

    expect(runtimeMocks.findUsablePlainApiKey).toHaveBeenCalledWith(
      expect.anything(),
      runtimeMocks.main.auth.id,
      runtimeMocks.organizationStore.currentOrganization.gid,
      undefined,
    )
    expect(runtimeMocks.createDefaultApiKey).not.toHaveBeenCalled()
  })

  it('shares an in-flight key load across concurrent onboarding component instances', async () => {
    let finishLookup: ((key: string | null) => void) | undefined
    runtimeMocks.findUsablePlainApiKey.mockImplementation(() => new Promise((resolve) => {
      finishLookup = resolve
    }))

    await Promise.all([
      mountFlow(),
      mountFlow(),
    ])

    await vi.waitFor(() => expect(runtimeMocks.findUsablePlainApiKey).toHaveBeenCalled())
    expect(runtimeMocks.findUsablePlainApiKey).toHaveBeenCalledTimes(1)

    finishLookup?.(null)
    await vi.waitFor(() => expect(runtimeMocks.createDefaultApiKey).toHaveBeenCalledTimes(1))
  })
})
