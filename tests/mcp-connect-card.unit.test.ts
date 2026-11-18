// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import McpConnectCard from '../src/components/McpConnectCard.vue'

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
vi.mock('~icons/heroicons/clipboard-document', () => ({ default: { name: 'IconClipboard', setup: () => () => null } }))
vi.mock('~icons/heroicons/sparkles', () => ({ default: { name: 'IconSparkles', setup: () => () => null } }))

describe('McpConnectCard hosted URL', () => {
  let container: HTMLDivElement
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.stubEnv('VITE_API_HOST', 'https://api.capgo.app')
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

  it('shows the China API MCP URL on console.capgo.com.cn', async () => {
    app = createApp(McpConnectCard)
    app.mount(container)
    await nextTick()
    const code = container.querySelector('[data-test="mcp-connect-copy-url"] code')
    expect(code?.textContent).toBe('https://api.capgo.com.cn/mcp')
  })

  it('copies the China MCP URL to the clipboard when the button is clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    app = createApp(McpConnectCard)
    app.mount(container)
    await nextTick()
    const button = container.querySelector('[data-test="mcp-connect-copy-url"]') as HTMLButtonElement
    button.click()
    await nextTick()
    expect(writeText).toHaveBeenCalledWith('https://api.capgo.com.cn/mcp')
  })
})