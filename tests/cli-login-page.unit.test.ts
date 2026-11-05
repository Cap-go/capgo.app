// @vitest-environment happy-dom

import type { App } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import LoginCliPage from '../src/pages/login-cli.vue'

const route = vi.hoisted(() => ({ query: { ai: '1' } as Record<string, string> }))
const router = vi.hoisted(() => ({ push: vi.fn() }))
const clipboardWrite = vi.hoisted(() => vi.fn())
const cliLoginMocks = vi.hoisted(() => ({
  createCliLoginKeyDependencies: vi.fn(() => ({})),
  getCliLoginDestination: vi.fn(() => '/dashboard'),
  isCliAiQuery: vi.fn((value: unknown) => {
    const raw = Array.isArray(value) ? value[0] : value
    return typeof raw === 'string' && raw.replace(/\/+$/, '') === '1'
  }),
  isMatchingCliLoginEvent: vi.fn(() => false),
  isValidCliLoginSession: vi.fn(() => true),
  prepareCliLoginKey: vi.fn(),
}))
const organizationApps = vi.hoisted(() => new Map([
  ['org-1', [{ app_id: 'com.test.app', name: 'Test App', owner_org: 'org-1', onboarding: { setup: { todo_list_version: 2 } } }]],
]))
const organizationStore = vi.hoisted(() => ({
  awaitInitialLoad: vi.fn(async () => {}),
  organizations: [{ gid: 'org-1', name: 'Test organization', app_count: 1 }],
  getAppsByOrgId: vi.fn((orgId: string) => organizationApps.get(orgId) ?? []),
}))
const capgo = vi.hoisted(() => ({
  channel: vi.fn(),
  from: vi.fn(),
  removeChannel: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => router,
}))

vi.mock('vue-sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

vi.mock('~/services/cliLogin', () => cliLoginMocks)

vi.mock('~/services/console', () => ({
  useConsole: () => capgo,
}))

vi.mock('~/stores/main', () => ({
  useMainStore: () => ({ user: { id: 'user-1' } }),
}))

vi.mock('~/stores/organization', () => ({
  isPendingOrganizationInvite: () => false,
  useOrganizationStore: () => organizationStore,
}))

const messages = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, string>
const preparedKey = 'capgo_ai_setup_secret'
const mountedApps: App[] = []

function mountLoginCliPage() {
  const app = createApp({ render: () => h(LoginCliPage) })
  app.use(createI18n({
    legacy: false,
    locale: 'en',
    messages: { en: messages },
  }))
  const container = document.createElement('div')
  document.body.append(container)
  app.mount(container)
  mountedApps.push(app)
  return container
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

beforeEach(() => {
  vi.clearAllMocks()
  route.query = { ai: '1' }
  cliLoginMocks.prepareCliLoginKey.mockResolvedValue({
    status: 'ready',
    keyName: 'Capgo CLI',
    secret: preparedKey,
    eligibleOrgIds: ['org-1'],
    skippedOrganizations: [],
    policy: { hashed: false, expiresAt: null },
    reused: false,
  })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWrite },
  })
})

afterEach(() => {
  mountedApps.splice(0).forEach(app => app.unmount())
  document.body.replaceChildren()
})

async function copyAiPrompt(container: HTMLElement) {
  const copyButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find(button => button.textContent?.includes(messages['cli-login-ai-copy']))
  expect(copyButton).toBeDefined()
  copyButton?.click()
  await flushPromises()
  expect(clipboardWrite).toHaveBeenCalledOnce()
  return clipboardWrite.mock.calls[0]?.[0] as string
}

describe('/login-cli page', () => {
  it('does not prepare a key in direct mode without a valid CLI session', async () => {
    route.query = {}
    cliLoginMocks.isValidCliLoginSession.mockReturnValueOnce(false)
    mountLoginCliPage()
    await flushPromises()

    expect(cliLoginMocks.prepareCliLoginKey).not.toHaveBeenCalled()
  })

  it('keeps the prepared key out of the DOM until explicit reveal in direct mode', async () => {
    route.query = { session: 'AbCdEfGhIjKlMnOpQrStUv' }
    const channel = { on: vi.fn(() => channel), subscribe: vi.fn((callback: (status: string) => void) => {
      callback('SUBSCRIBED')
      return channel
    }) }
    capgo.channel.mockReturnValue(channel)
    const container = mountLoginCliPage()
    await flushPromises()
    await vi.waitFor(() => expect(container.textContent).toContain('capgo_xxxxxxxxxxxxxxxxxxxx'))

    expect(cliLoginMocks.prepareCliLoginKey).toHaveBeenCalledOnce()
    expect(container.innerHTML).not.toContain(preparedKey)
  })

  it('stops waiting for a silent event stream after the fallback delay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      route.query = { session: 'AbCdEfGhIjKlMnOpQrStUv' }
      // The channel never reports a status, as when the events request hangs.
      const channel = { on: vi.fn(() => channel), subscribe: vi.fn(() => channel) }
      capgo.channel.mockReturnValue(channel)
      const container = mountLoginCliPage()
      await flushPromises()
      expect(container.textContent).not.toContain(messages['cli-login-realtime-unavailable'])

      await vi.advanceTimersByTimeAsync(15_000)
      await flushPromises()
      expect(container.textContent).toContain(messages['cli-login-realtime-unavailable'])
      expect(container.textContent).toContain('capgo_xxxxxxxxxxxxxxxxxxxx')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('copies a prompt containing the prepared key in AI mode', async () => {
    const container = mountLoginCliPage()
    await flushPromises()

    const copiedPrompt = await copyAiPrompt(container)
    expect(copiedPrompt).toContain(`login ${preparedKey}`)
    expect(copiedPrompt).toContain('Organization: "Test organization" (organization ID: `org-1`)')
    expect(copiedPrompt).toContain('App: "Test App" (Capgo app ID: `com.test.app`)')
    expect(copiedPrompt).toContain('## 8. Test the first live update')
    expect(copiedPrompt.match(new RegExp(preparedKey, 'g'))).toHaveLength(1)
  })

  it('copies the Builder prompt when requested by route intent', async () => {
    route.query = { ai: '1', intent: 'builder' }
    const container = mountLoginCliPage()
    await flushPromises()

    const copiedPrompt = await copyAiPrompt(container)
    expect(copiedPrompt).toContain(`login ${preparedKey}`)
    expect(copiedPrompt).toContain('start_capgo_builder_onboarding')
    expect(copiedPrompt).not.toContain('## 8. Test the first live update')
  })

  it.each([
    [3, true],
    [2, false],
  ])('copies OTA checklist checkpoints for explicit OTA intent and a v%s app: %s', async (todoListVersion, expectChecklist) => {
    route.query = { ai: '1', intent: 'ota' }
    organizationStore.getAppsByOrgId.mockReturnValueOnce([{
      app_id: 'com.test.app',
      name: 'Test App',
      owner_org: 'org-1',
      onboarding: { setup: { todo_list_version: todoListVersion } },
    }])
    const container = mountLoginCliPage()
    await flushPromises()

    const copiedPrompt = await copyAiPrompt(container)
    expect(copiedPrompt.includes('app todo {SELECTED_CAPGO_APP_ID}')).toBe(expectChecklist)
    expect(copiedPrompt.includes('OTA todo list progress checks')).toBe(expectChecklist)
  })
})
