// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'

/** Literal China login command (must match helper output; not derived from the helper in assertions). */
const CHINA_LOGIN_COMMAND = 'npx @capgo/cli@latest login --api-host https://api.capgo.com.cn'

vi.mock('@vuepic/vue-datepicker', () => ({ VueDatePicker: { template: '<div />' } }))
vi.mock('~/components/permissions/ChannelPermissionOverridesPanel.vue', () => ({ default: { template: '<div />' } }))
vi.mock('~/services/capgoApi', () => ({
  invokeCapgoApi: async () => ({ data: [], error: null }),
}))
vi.mock('~/services/nativeCompliance', () => ({ isNativeAppStoreContext: () => false }))
vi.mock('~/services/permissions', () => ({ checkPermissionsBatch: async () => ({}) }))
vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key }),
  }
})
vi.mock('vue-sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('~/stores/dialogv2', () => ({ useDialogV2Store: () => ({ openDialog: vi.fn() }) }))
vi.mock('~/stores/display', () => ({
  useDisplayStore: () => ({
    isMobile: false,
    NavTitle: '',
    defaultBack: '/apps',
  }),
}))
vi.mock('~/stores/main', () => ({ useMainStore: () => ({ user: { id: 'user-1' } }) }))
vi.mock('~/stores/organization', () => ({
  useOrganizationStore: () => ({
    currentOrganization: { gid: 'org-1', name: 'Org' },
    awaitInitialLoad: vi.fn(),
    organizations: [{ gid: 'org-1', name: 'Org' }],
  }),
}))
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
          order: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    }),
  }),
}))
vi.mock('vue-router', () => ({
  RouterLink: { template: '<a><slot /></a>' },
}))
vi.mock('~icons/heroicons/arrow-path', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/heroicons/calendar', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/heroicons/clipboard-document', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/heroicons/command-line', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/heroicons/lock-closed', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/heroicons/pencil', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/heroicons/shield-check', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/heroicons/trash', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/heroicons/x-mark', () => ({ default: { setup: () => () => null } }))

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

describe('ApiKeys CLI login guidance on China console', () => {
  let container: HTMLDivElement
  let app: ReturnType<typeof createApp>
  const writeText = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    vi.stubEnv('VITE_API_HOST', 'https://api.capgo.app')
    vi.stubEnv('VITE_APP_URL', 'https://console.capgo.com.cn')
    setChinaConsoleLocation()
    writeText.mockClear()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
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

  it('shows the login command with the China API host and copies the same literal', async () => {
    const ApiKeysPage = (await import('../src/pages/ApiKeys.vue')).default
    app = createApp(ApiKeysPage)
    app.component('DataTable', { template: '<div data-test="api-key-data-table" />' })
    app.component('SectionIntro', { template: '<div />' })
    app.component('FormField', { template: '<div><slot /></div>' })
    app.component('RoleCapabilitiesHint', { template: '<div />' })
    app.mount(container)
    await nextTick()
    await vi.waitFor(() => expect(container.querySelector('[data-test="cli-login-guidance"] code')).not.toBeNull())
    const code = container.querySelector('[data-test="cli-login-guidance"] code')
    expect(code?.textContent).toBe(CHINA_LOGIN_COMMAND)
    expect(code?.textContent).not.toContain('api.capgo.app')
    expect(container.querySelector('[data-test="cli-login-guidance-description"]')?.textContent)
      .toBe('cli-login-guidance-description-china-api')
    const copyButton = container.querySelector('[data-test="cli-login-guidance-copy"]') as HTMLButtonElement | null
    expect(copyButton).not.toBeNull()
    copyButton!.click()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(CHINA_LOGIN_COMMAND))
  })
})