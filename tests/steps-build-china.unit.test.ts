// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import StepsBuild from '../src/components/dashboard/StepsBuild.vue'
import { buildInitCliCommand } from '../src/utils/onboardingSetupMode'

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key }),
  }
})
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))
vi.mock('vue-sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('~/services/apikeys', () => ({
  findUsablePlainApiKey: vi.fn().mockResolvedValue('build-setup-api-key'),
  createDefaultApiKey: vi.fn(),
}))
vi.mock('~/services/onboardingTracking', () => ({ sendOnboardingEvent: vi.fn() }))
vi.mock('~/services/tracking', () => ({ sendEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('~/stores/dialogv2', () => ({ useDialogV2Store: () => ({ openDialog: vi.fn(), onDialogDismiss: vi.fn(async () => undefined), lastButtonRole: null }) }))
vi.mock('~/stores/main', () => ({ useMainStore: () => ({ user: { id: 'user-1' } }) }))
vi.mock('~/stores/organization', () => ({ useOrganizationStore: () => ({ currentOrganization: { gid: 'org-1' }, awaitInitialLoad: vi.fn() }) }))
vi.mock('~/composables/useSetupMethodPreference', () => ({
  useSetupMethodPreference: () => ({ manualFirst: true, rememberSetupMethod: vi.fn() }),
}))
vi.mock('~/services/capgoApi', () => ({ invokeCapgoApi: vi.fn().mockResolvedValue({ data: null, error: null }) }))
vi.mock('~/components/dashboard/AiAgentTaskCard.vue', () => ({ default: { template: '<div />' } }))
vi.mock('~/components/dashboard/BuildLiveProgress.vue', () => ({ default: { template: '<div />' } }))
vi.mock('~/components/dashboard/TechnicalTeammateInviteCard.vue', () => ({ default: { template: '<div />' } }))
vi.mock('~icons/lucide/arrow-left', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/lucide/check-circle-2', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/lucide/clipboard', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/lucide/external-link', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/lucide/loader-2', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/lucide/play', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/lucide/settings-2', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/lucide/terminal-square', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/mdi/android', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/mdi/apple', () => ({ default: { setup: () => () => null } }))
function chinaConsoleWebHost() {
  return typeof window !== 'undefined' && window.location.hostname.endsWith('.capgo.com.cn')
}

vi.mock('~/services/console', () => ({
  getLocalConfig: () => ({
    apiHost: chinaConsoleWebHost() ? 'https://api.capgo.com.cn' : 'https://api.capgo.app',
    host: typeof window !== 'undefined' ? window.location.origin : 'https://console.capgo.app',
    hostWeb: '',
    stripeEnabled: true,
  }),
  getConsoleApiHost: () => (chinaConsoleWebHost() ? 'https://api.capgo.com.cn' : 'https://api.capgo.app'),
  PROD_API_URL: 'https://api.capgo.app',
  useConsole: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          limit: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    }),
  }),
}))

const CHINA_SUFFIX = ' --api-host https://api.capgo.com.cn'
const API_KEY = 'build-setup-api-key'

function setChinaConsoleLocation() {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      hostname: 'console.capgo.com.cn',
      origin: 'https://console.capgo.com.cn',
      href: 'https://console.capgo.com.cn/',
      search: '',
    },
  })
}

describe('StepsBuild setup commands on China console', () => {
  let container: HTMLDivElement
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.stubEnv('VITE_API_HOST', 'https://api.capgo.app')
    vi.stubEnv('VITE_APP_URL', 'https://console.capgo.com.cn')
    setChinaConsoleLocation()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    app?.unmount()
    container.remove()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  async function mountStepsBuild() {
    app = createApp(StepsBuild, {
      onboarding: true,
      appId: 'com.demo.app',
      platformBuildCounts: { ios: 0, android: 0 },
      canClose: false,
    })
    app.mount(container)
    await nextTick()
    await vi.waitFor(() => {
      expect(container.textContent).toContain(API_KEY)
    })
  }

  function commandTexts() {
    return [...container.querySelectorAll('code')].map(node => node.textContent ?? '')
  }

  it('shows ios and android build init commands with the China API host', async () => {
    await mountStepsBuild()
    const setupCommand = () => commandTexts().find(text => text.includes('build init'))
    expect(setupCommand()).toBe(buildInitCliCommand(API_KEY, CHINA_SUFFIX, 'ios'))
    const androidTab = [...container.querySelectorAll('button')].find(button =>
      button.textContent?.includes('build-platform-android'),
    )
    expect(androidTab).toBeTruthy()
    androidTab!.click()
    await nextTick()
    expect(setupCommand()).toBe(buildInitCliCommand(API_KEY, CHINA_SUFFIX, 'android'))
    for (const command of commandTexts())
      expect(command).toContain(CHINA_SUFFIX)
  })
})