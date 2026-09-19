// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import GettingStartedCliPanel from '../src/components/dashboard/GettingStartedCliPanel.vue'

const runtimeMocks = vi.hoisted(() => ({
  createDefaultApiKey: vi.fn(),
  findUsablePlainApiKey: vi.fn(async (): Promise<string | null> => 'runtime-api-key'),
  main: {
    auth: { id: 'user-runtime-onboarding' },
    user: { id: 'user-runtime-onboarding', onboarding: {} } as { id: string, onboarding: Record<string, unknown> } | null,
  },
  organizationStore: {
    getOrgByAppId: vi.fn(() => ({ gid: 'org-runtime-onboarding' })),
    setCurrentOrganization: vi.fn(),
    awaitInitialLoad: vi.fn(async () => undefined),
    currentOrganization: { gid: 'org-runtime-onboarding', name: 'Runtime organization' },
    organizations: [],
    updateAppOnboarding: vi.fn(),
  },
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
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
      single: async () => ({ data: { onboarding: {} }, error: null }),
    }
    return {
      auth: { getClaims: async () => ({ data: { claims: { sub: runtimeMocks.main.auth.id } } }) },
      from: () => query,
      rpc: async () => ({ data: null, error: null }),
    }
  },
}))
vi.mock('~/stores/dialogv2', () => ({
  useDialogV2Store: () => ({
    lastButtonRole: null,
    onDialogDismiss: vi.fn(async () => undefined),
    openDialog: vi.fn(),
  }),
}))
vi.mock('~/stores/main', () => ({ useMainStore: () => runtimeMocks.main }))
vi.mock('~/stores/organization', () => ({ useOrganizationStore: () => runtimeMocks.organizationStore }))

interface MountedPanel {
  app: ReturnType<typeof createApp>
  container: HTMLDivElement
}

const mountedPanels: MountedPanel[] = []

async function mountPanel() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(GettingStartedCliPanel, {
    appId: 'com.test.runtime-onboarding',
    appName: 'Runtime onboarding app',
    existingApp: false,
  })
  app.config.warnHandler = () => undefined
  app.mount(container)
  const mounted = { app, container }
  mountedPanels.push(mounted)
  return mounted
}

function element<T extends Element>(container: Element, selector: string) {
  const value = container.querySelector<T>(selector)
  if (!value)
    throw new Error(`Missing getting-started element: ${selector}`)
  return value
}

async function click(container: Element, selector: string) {
  element<HTMLButtonElement>(container, selector).click()
  await nextTick()
}

beforeEach(() => {
  runtimeMocks.createDefaultApiKey.mockReset()
  runtimeMocks.createDefaultApiKey.mockResolvedValue({ data: { key: 'runtime-created-api-key' }, error: null })
  runtimeMocks.findUsablePlainApiKey.mockReset()
  runtimeMocks.findUsablePlainApiKey.mockResolvedValue('runtime-api-key')
  runtimeMocks.main.user = { id: runtimeMocks.main.auth.id, onboarding: {} }
  runtimeMocks.organizationStore.awaitInitialLoad.mockClear()
  runtimeMocks.organizationStore.updateAppOnboarding.mockClear()
  vi.stubGlobal('navigator', {
    ...navigator,
    clipboard: { writeText: vi.fn(async () => undefined) },
  })
})

afterEach(() => {
  for (const mounted of mountedPanels.splice(0)) {
    mounted.app.unmount()
    mounted.container.remove()
  }
})

describe('getting started API key runtime loading', () => {
  it('reuses a key when Getting Started opens for an app', async () => {
    await mountPanel()

    await vi.waitFor(() => expect(runtimeMocks.findUsablePlainApiKey).toHaveBeenCalledTimes(1))
    expect(runtimeMocks.findUsablePlainApiKey).toHaveBeenCalledWith(
      expect.anything(),
      runtimeMocks.main.auth.id,
      runtimeMocks.organizationStore.currentOrganization.gid,
      'com.test.runtime-onboarding',
    )
    expect(runtimeMocks.createDefaultApiKey).not.toHaveBeenCalled()
  })

  it('uses the authenticated user ID while the public profile is still loading', async () => {
    runtimeMocks.main.user = null

    await mountPanel()

    await vi.waitFor(() => expect(runtimeMocks.findUsablePlainApiKey).toHaveBeenCalledTimes(1))
    expect(runtimeMocks.findUsablePlainApiKey).toHaveBeenCalledWith(
      expect.anything(),
      runtimeMocks.main.auth.id,
      runtimeMocks.organizationStore.currentOrganization.gid,
      'com.test.runtime-onboarding',
    )
  })

  it('retries a settled failed load when copying AI instructions', async () => {
    const loadError = new Error('transient API-key failure')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    runtimeMocks.findUsablePlainApiKey
      .mockRejectedValueOnce(loadError)
      .mockResolvedValueOnce('runtime-retried-api-key')

    try {
      const { container } = await mountPanel()
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith('Cannot ensure API key', loadError))
      await click(container, '[data-test="getting-started-cli-copy-ai"]')

      await vi.waitFor(() => expect(runtimeMocks.findUsablePlainApiKey).toHaveBeenCalledTimes(2))
    }
    finally {
      consoleError.mockRestore()
    }
  })

  it('retries a settled failed load when the CLI copy button becomes available', async () => {
    const loadError = new Error('transient API-key failure')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    runtimeMocks.findUsablePlainApiKey
      .mockRejectedValueOnce(loadError)
      .mockResolvedValueOnce('runtime-retried-api-key')

    try {
      const { container } = await mountPanel()
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith('Cannot ensure API key', loadError))
      await click(container, '[data-test="getting-started-cli-copy-ai"]')
      await vi.waitFor(() => expect(container.querySelector('[data-test="getting-started-cli-command-copy"]')).not.toBeNull())
      await click(container, '[data-test="getting-started-cli-command-copy"]')

      await vi.waitFor(() => expect(runtimeMocks.findUsablePlainApiKey).toHaveBeenCalledTimes(2))
    }
    finally {
      consoleError.mockRestore()
    }
  })

  it('dedupes in-flight key loads within one Getting Started panel', async () => {
    let finishLookup: ((key: string | null) => void) | undefined
    runtimeMocks.findUsablePlainApiKey.mockImplementation(() => new Promise((resolve) => {
      finishLookup = resolve
    }))

    const { container } = await mountPanel()
    await click(container, '[data-test="getting-started-cli-copy-ai"]')

    await vi.waitFor(() => expect(runtimeMocks.findUsablePlainApiKey).toHaveBeenCalledTimes(1))

    finishLookup?.('runtime-shared-api-key')
    await vi.waitFor(() => expect(container.querySelector('[data-test="getting-started-cli-command-copy"]')).not.toBeNull())
  })
})
