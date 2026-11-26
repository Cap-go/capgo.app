// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import StepsBuild from '../src/components/dashboard/StepsBuild.vue'

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
const { invokeCapgoApiMock } = vi.hoisted(() => ({ invokeCapgoApiMock: vi.fn() }))
vi.mock('~/services/capgoApi', () => ({ invokeCapgoApi: invokeCapgoApiMock }))
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
vi.mock('~/services/console', () => ({
  getLocalConfig: () => ({ apiHost: 'https://api.capgo.app', host: 'https://console.capgo.app', hostWeb: '', stripeEnabled: true }),
  getConsoleApiHost: () => 'https://api.capgo.app',
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

const API_KEY = 'build-setup-api-key'
const variant = (xcode: string, extra: Record<string, unknown> = {}) => ({
  platform: 'ios',
  id: `xcode-${xcode}`,
  xcode_version: xcode,
  macos_version: '26.1',
  backend: 'mac',
  runners: 1,
  online: 1,
  default: false,
  ...extra,
})

describe('StepsBuild Xcode variant selector', () => {
  let container: HTMLDivElement
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.stubEnv('VITE_API_HOST', 'https://api.capgo.app')
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    app?.unmount()
    container.remove()
    vi.unstubAllEnvs()
    vi.resetModules()
    invokeCapgoApiMock.mockReset()
  })

  async function mount(builds = { ios: 1, android: 1 }) {
    app = createApp(StepsBuild, { onboarding: false, appId: 'com.demo.app', platformBuildCounts: builds, canClose: true })
    app.mount(container)
    await nextTick()
    await vi.waitFor(() => expect(container.textContent).toContain(API_KEY))
  }

  const requestCommand = () => [...container.querySelectorAll('code')].map(node => node.textContent ?? '').find(text => text.includes('build request'))
  const selector = () => container.querySelector('[data-test="build-xcode-variant"] select') as HTMLSelectElement | null
  const optionValues = () => Array.from(selector()?.querySelectorAll('option') ?? [], option => option.getAttribute('value') ?? '')

  it('lists the builder variants for iOS and adds the chosen Xcode to the command', async () => {
    invokeCapgoApiMock.mockResolvedValue({ data: { variants: [variant('27.1', { backend: 'linux', macos_version: null }), variant('26.2', { default: true })] }, error: null })
    await mount()
    await vi.waitFor(() => expect(selector()).toBeTruthy())
    expect(invokeCapgoApiMock).toHaveBeenCalledWith('build/variants?platform=ios', expect.objectContaining({ method: 'GET' }))
    expect(optionValues()).toEqual(['', '27.1', '26.2'])
    expect(requestCommand()).not.toContain('--xcode-version')

    selector()!.value = '26.2'
    selector()!.dispatchEvent(new Event('change'))
    await nextTick()
    expect(requestCommand()).toContain('--platform ios --xcode-version 26.2')

    const androidTab = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('build-platform-android'))
    androidTab!.click()
    await nextTick()
    expect(selector()).toBeNull()
    expect(requestCommand()).not.toContain('--xcode-version')
  })

  it('lets a first iOS build pick an Xcode on the setup step, where the AI card is shown', async () => {
    invokeCapgoApiMock.mockResolvedValue({ data: { variants: [variant('27.1'), variant('26.2')] }, error: null })
    await mount({ ios: 0, android: 0 })
    await vi.waitFor(() => expect(selector()).toBeTruthy())
    expect(container.querySelector('#build_step_0')?.textContent).toContain('build init')
    expect(selector()!.disabled).toBe(false)
  })

  it('drops versions that are not dotted numbers so they never reach the command', async () => {
    invokeCapgoApiMock.mockResolvedValue({ data: { variants: [variant('26; rm -rf ~'), variant('26.2')] }, error: null })
    await mount()
    await vi.waitFor(() => expect(selector()).toBeTruthy())
    expect(optionValues()).toEqual(['', '26.2'])
  })

  it('hides the selector when the builder reports no variants or the call fails', async () => {
    invokeCapgoApiMock.mockResolvedValue({ data: null, error: new Error('503') })
    await mount()
    await nextTick()
    expect(selector()).toBeNull()
    expect(requestCommand()).not.toContain('--xcode-version')
  })
})
