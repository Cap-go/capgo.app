// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import AppOnboardingBuilderAiSetup from '../src/components/dashboard/AppOnboardingBuilderAiSetup.vue'

const mocks = vi.hoisted(() => ({ writeText: vi.fn(), success: vi.fn() }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('vue-sonner', () => ({ toast: { success: mocks.success } }))

let app: ReturnType<typeof createApp> | undefined
let container: HTMLDivElement
const onCopy = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  mocks.writeText.mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText: mocks.writeText } })
  container = document.createElement('div')
  app = createApp(AppOnboardingBuilderAiSetup, { onCopy })
  app.mount(container)
})

afterEach(() => {
  app?.unmount()
  vi.unstubAllGlobals()
})

describe('explicit Builder MCP installation', () => {
  it.each(['codex', 'cursor', 'claude-code', 'windsurf', 'vscode', 'zed'])('copies the installation command for %s without starting account setup', async (client) => {
    container.querySelector<HTMLButtonElement>(`[data-test="builder-mcp-client-${client}"]`)!.click()
    await nextTick()
    const expected = `npx install-mcp "npx @capgo/cli@latest mcp" --client ${client}`
    expect(container.querySelector('[data-test="builder-mcp-install-command"]')!.textContent).toBe(expected)
    expect(container.querySelector(`[data-test="builder-mcp-client-${client}"]`)!.getAttribute('aria-pressed')).toBe('true')
    container.querySelector<HTMLButtonElement>('[data-test="builder-mcp-copy-install"]')!.click()
    await vi.waitFor(() => expect(mocks.success).toHaveBeenCalledOnce())
    expect(mocks.writeText).toHaveBeenCalledWith(expected)
    expect(onCopy).not.toHaveBeenCalled()
  })

  it('keeps the command visible and avoids a false success when clipboard access fails', async () => {
    mocks.writeText.mockRejectedValueOnce(new Error('Clipboard unavailable'))
    container.querySelector<HTMLButtonElement>('[data-test="builder-mcp-copy-install"]')!.click()
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull())
    expect(container.querySelector('[data-test="builder-mcp-install-command"]')!.textContent).toContain('--client codex')
    expect(mocks.success).not.toHaveBeenCalled()
    expect(onCopy).not.toHaveBeenCalled()
  })

  it('hands account-connected setup to the existing copy handler separately from installation', () => {
    container.querySelector<HTMLButtonElement>('[data-test="builder-checklist-copy-ai"]')!.click()
    expect(onCopy).toHaveBeenCalledOnce()
    expect(mocks.writeText).not.toHaveBeenCalled()
  })
})
