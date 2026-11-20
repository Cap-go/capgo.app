// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import BuildLiveProgress from '../src/components/dashboard/BuildLiveProgress.vue'

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key }),
  }
})
vi.mock('vue-sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('~/stores/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { gid: 'org-1' } }),
}))
vi.mock('~/services/tracking', () => ({ sendEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('~/services/capgoApi', () => ({
  invokeCapgoApi: vi.fn().mockResolvedValue({ data: null, error: { message: 'skip' } }),
}))
vi.mock('~/services/previewQrCode', () => ({ buildPreviewQrCodeDataUrl: () => '' }))
const consoleFromMock = vi.fn(() => ({
  select: vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          status: 'pending',
          created_at: new Date().toISOString(),
          started_at: null,
          completed_at: null,
          last_error: null,
          builder_job_id: null,
        },
        error: null,
      }),
    }),
  }),
}))
vi.mock('~/services/console', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/services/console')>()
  return {
    ...actual,
    useConsole: () => ({ from: consoleFromMock }),
  }
})
vi.mock('~icons/lucide/alert-circle', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/lucide/arrow-left', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/lucide/check-circle-2', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/lucide/circle', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/lucide/download', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/lucide/loader-2', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/lucide/rotate-ccw', () => ({ default: { setup: () => () => null } }))
vi.mock('~icons/lucide/sparkles', () => ({ default: { setup: () => () => null } }))

describe('BuildLiveProgress CLI copy on China console', () => {
  let container: HTMLDivElement
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.stubEnv('VITE_API_HOST', 'https://api.capgo.app')
    vi.stubEnv('VITE_APP_URL', 'https://console.capgo.com.cn')
    vi.stubGlobal('window', {
      location: { hostname: 'console.capgo.com.cn', origin: 'https://console.capgo.com.cn' },
    })
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

  it('shows build request CLI with China --api-host on console.capgo.com.cn', async () => {
    app = createApp(BuildLiveProgress, {
      appId: 'com.demo.app',
      buildId: 'build-1',
      platform: 'ios',
      embedded: true,
    })
    app.mount(container)
    await nextTick()
    await vi.waitFor(() => {
      const root = container.querySelector('[data-test="build-live-progress"]')
      expect(root?.textContent).toContain('build request com.demo.app')
    })
    const root = container.querySelector('[data-test="build-live-progress"]')
    expect(root?.textContent).toContain('--api-host https://api.capgo.com.cn')
  })
})