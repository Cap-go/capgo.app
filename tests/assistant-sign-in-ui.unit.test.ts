// @vitest-environment happy-dom

import type { App } from 'vue'
import type { ChatGptCredentials } from '../src/services/chatgptAuth'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '../messages/en.json'
import AssistantChat from '../src/components/assistant/AssistantChat.vue'
import DialogV2 from '../src/components/DialogV2.vue'
import { CHATGPT_REDIRECT_URI } from '../src/services/chatgptAuth'

const mocks = vi.hoisted(() => ({
  nativePlatform: vi.fn(() => false),
  createKey: vi.fn(async () => 'assistant-key'),
  loadKey: vi.fn(() => ''),
  saveKey: vi.fn(),
  beginSignIn: vi.fn(async () => 'https://auth.openai.com/test-sign-in'),
  completeSignIn: vi.fn(),
  loadCredentials: vi.fn<() => ChatGptCredentials | null>(() => null),
  openWebView: vi.fn(async () => {}),
  closeWebView: vi.fn(async () => {}),
  browserListeners: new Map<string, (event: { url: string }) => void>(),
  removeListener: vi.fn(async () => {}),
}))

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: mocks.nativePlatform }, CapacitorHttp: {} }))
vi.mock('@capgo/capacitor-inappbrowser', () => ({
  InAppBrowser: {
    openWebView: mocks.openWebView,
    close: mocks.closeWebView,
    addListener: vi.fn(async (name: string, handler: (event: { url: string }) => void) => {
      mocks.browserListeners.set(name, handler)
      return { remove: mocks.removeListener }
    }),
  },
}))
vi.mock('~/services/console', () => ({ defaultApiHost: 'https://api.capgo.test', useConsole: () => ({}) }))
vi.mock('~/stores/main', () => ({ useMainStore: () => ({ user: { id: 'assistant-ui-test-user' } }) }))
vi.mock('~/stores/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: null, organizations: [], awaitInitialLoad: async () => {} }),
}))
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ push: vi.fn() }) }))
vi.mock('~/services/assistant', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/assistant')>(),
  createAssistantKey: mocks.createKey,
  loadAssistantKey: mocks.loadKey,
  saveAssistantKey: mocks.saveKey,
}))
vi.mock('~/services/chatgptAuth', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/chatgptAuth')>(),
  beginChatGptSignIn: mocks.beginSignIn,
  completeChatGptSignIn: mocks.completeSignIn,
  loadChatGptCredentials: mocks.loadCredentials,
}))

const route = reactive({ fullPath: '/dashboard', params: {} })
const savedCredentials: ChatGptCredentials = {
  clientId: 'test-client', email: 'assistant-ui@example.com', accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token', expiresAt: Date.now() + 3600_000, scopes: [],
}
const popup = { location: { href: '' }, close: vi.fn() }
let app: App | undefined

async function flushUpdates() {
  await Promise.resolve()
  await nextTick()
  await nextTick()
}

function element<Kind extends HTMLElement = HTMLButtonElement>(selector: string): Kind {
  const found = document.querySelector<Kind>(selector)
  expect(found, selector).not.toBeNull()
  return found!
}

async function mountAssistant() {
  app = createApp({ render: () => [h(DialogV2), h(AssistantChat)] })
  app.use(createPinia())
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }))
  const container = document.createElement('div')
  document.body.appendChild(container)
  app.mount(container)
  element('[data-test="assistant-toggle"]').click()
  await flushUpdates()
}

async function requestSignIn() {
  await mountAssistant()
  element('[data-test="assistant-chatgpt-button"]').click()
  await flushUpdates()
}

beforeEach(() => {
  vi.clearAllMocks()
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  mocks.nativePlatform.mockReturnValue(false)
  mocks.loadCredentials.mockReturnValue(null)
  mocks.loadKey.mockReturnValue('')
  mocks.browserListeners.clear()
  mocks.completeSignIn.mockResolvedValue(savedCredentials)
  popup.location.href = ''
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
  vi.stubGlobal('useRoute', () => route)
})

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('assistant ChatGPT callback instructions', () => {
  it('explains the expected error page and callback before opening sign-in or creating a key', async () => {
    await requestSignIn()
    const instructions = element('[data-test="assistant-chatgpt-sign-in-instructions"]')
    expect(instructions.textContent).toContain(en['assistant-chatgpt-sign-in-step-copy'])
    expect(instructions.textContent).toContain(en['assistant-chatgpt-sign-in-step-paste'])
    expect(instructions.textContent).toContain(en['assistant-chatgpt-sign-in-private'])
    expect(instructions.textContent).toContain(`${CHATGPT_REDIRECT_URI}?code=…&state=…`)
    expect(element('dialog').getAttribute('aria-modal')).toBe('true')
    expect(window.open).not.toHaveBeenCalled()
    expect(mocks.createKey).not.toHaveBeenCalled()
    expect(mocks.beginSignIn).not.toHaveBeenCalled()
  })

  it('cancels without opening a window or starting authorization', async () => {
    await requestSignIn()
    const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>('dialog button')).find(button => button.textContent?.trim() === en['button-cancel'])
    expect(cancel).toBeDefined()
    cancel!.click()
    await flushUpdates()
    expect(document.querySelector('dialog')).toBeNull()
    expect(window.open).not.toHaveBeenCalled()
    expect(mocks.createKey).not.toHaveBeenCalled()
    expect(mocks.beginSignIn).not.toHaveBeenCalled()
  })

  it('opens the popup synchronously on confirmation and retains the paste flow', async () => {
    await requestSignIn()
    element('[data-test="assistant-chatgpt-sign-in-open"]').click()
    expect(window.open).toHaveBeenCalledOnce()
    await flushUpdates()
    expect(document.querySelector('dialog')).toBeNull()
    expect(mocks.beginSignIn).toHaveBeenCalledWith('assistant-ui-test-user')
    expect(popup.location.href).toBe('https://auth.openai.com/test-sign-in')
    const input = element<HTMLInputElement>('[data-test="assistant-chatgpt-paste-input"]')
    expect(input.getAttribute('aria-label')).toBe(en['assistant-chatgpt-callback-label'])
    input.value = `${CHATGPT_REDIRECT_URI}?code=test-code&state=test-state&client_id=test-client`
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUpdates()
    element<HTMLFormElement>('[data-test="assistant-chatgpt-paste"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushUpdates()
    expect(mocks.completeSignIn).toHaveBeenCalledWith('assistant-ui-test-user', { code: 'test-code', state: 'test-state', clientId: 'test-client', error: undefined })
    expect(popup.close).toHaveBeenCalledOnce()
  })

  it('dismisses instructions with Escape without closing the assistant', async () => {
    await requestSignIn()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushUpdates()
    expect(document.querySelector('dialog')).toBeNull()
    expect(document.querySelector('[data-test="assistant-panel"]')).not.toBeNull()
    expect(window.open).not.toHaveBeenCalled()
  })

  it('does not show callback instructions when only the Capgo key needs to be recreated', async () => {
    mocks.loadCredentials.mockReturnValue(savedCredentials)
    await requestSignIn()
    expect(document.querySelector('dialog')).toBeNull()
    expect(mocks.createKey).toHaveBeenCalledOnce()
    expect(mocks.beginSignIn).not.toHaveBeenCalled()
    expect(window.open).not.toHaveBeenCalled()
  })

  it('keeps the native automatic callback without copy/paste instructions', async () => {
    mocks.nativePlatform.mockReturnValue(true)
    await requestSignIn()
    await vi.waitFor(() => expect(mocks.openWebView).toHaveBeenCalledOnce())
    expect(document.querySelector('dialog')).toBeNull()
    expect(window.open).not.toHaveBeenCalled()
    mocks.browserListeners.get('urlChangeEvent')?.({ url: `${CHATGPT_REDIRECT_URI}?code=native-code&state=native-state&client_id=test-client` })
    await flushUpdates()
    expect(mocks.completeSignIn).toHaveBeenCalledWith('assistant-ui-test-user', { code: 'native-code', state: 'native-state', clientId: 'test-client', error: undefined })
    expect(mocks.closeWebView).toHaveBeenCalledOnce()
  })
})
