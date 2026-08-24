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
  isMatchingCliLoginEvent: vi.fn(() => false),
  isValidCliLoginSession: vi.fn(() => true),
  prepareCliLoginKey: vi.fn(),
}))
const organizationApps = vi.hoisted(() => new Map([
  ['org-1', [{ app_id: 'com.test.app', name: 'Test App', owner_org: 'org-1' }]],
]))
const organizationStore = vi.hoisted(() => ({
  awaitInitialLoad: vi.fn(async () => {}),
  organizations: [{ gid: 'org-1', name: 'Test organization', app_count: 1 }],
  getAppsByOrgId: vi.fn((orgId: string) => organizationApps.get(orgId) ?? []),
}))
const supabase = vi.hoisted(() => ({
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

vi.mock('~/services/supabase', () => ({
  useSupabase: () => supabase,
}))

vi.mock('~/stores/main', () => ({
  useMainStore: () => ({ user: { id: 'user-1' } }),
}))

vi.mock('~/stores/organization', () => ({
  isPendingOrganizationInvite: () => false,
  useOrganizationStore: () => organizationStore,
}))

const pagePath = resolve(process.cwd(), 'src/pages/login-cli.vue')
const auth = readFileSync(resolve(process.cwd(), 'src/modules/auth.ts'), 'utf8')
const organizationStoreSource = readFileSync(resolve(process.cwd(), 'src/stores/organization.ts'), 'utf8')
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
    skippedOrganizationNames: [],
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

describe('/login-cli page contract', () => {
  it.concurrent('uses the naked layout and does not reuse connect controls', () => {
    const page = readFileSync(pagePath, 'utf8')
    expect(page).toContain('layout: naked')
    expect(page).not.toContain('ConnectAppPicker')
    expect(page).not.toContain('tokenName')
    expect(page).not.toContain('selectedOrgIds')
  })

  it.concurrent('keeps a fake key in the DOM until explicit reveal', () => {
    const page = readFileSync(pagePath, 'utf8')
    expect(page).toContain(`const hiddenKey = 'capgo_xxxxxxxxxxxxxxxxxxxx'`)
    expect(page).toContain('revealed.value && secret.value ? secret.value : hiddenKey')
    expect(page).toContain('revealDialogOpen.value = true')
    expect(page).toContain('revealed.value = true')
    expect(page).toContain('await navigator.clipboard.writeText(secret.value)')
    expect(page).toContain('await copyKey()')
    expect(page).toContain('secret.value = null')
  })

  it.concurrent('shows preparation progress and a three-action reveal dialog', () => {
    const page = readFileSync(pagePath, 'utf8')
    expect(page).toContain('d-loading d-loading-spinner')
    expect(page).toContain('IconEyeSlash v-if="revealed"')
    expect(page).toContain('IconEye v-else')
    expect(page).toContain('@click="closeRevealDialog"')
    expect(page).toContain('@click="copyFromRevealDialog"')
    expect(page).toContain('@click="confirmReveal"')
    expect(page).toContain('aria-labelledby="cli-login-reveal-dialog-title"')
  })

  it.concurrent('traps reveal-dialog focus and restores it to the reveal button', () => {
    const page = readFileSync(pagePath, 'utf8')
    expect(page).toContain('ref="revealButtonRef"')
    expect(page).toContain('ref="revealDialogRef"')
    expect(page).toContain(`window.addEventListener('keydown', onRevealDialogKeydown)`)
    expect(page).toContain(`if (event.key !== 'Tab')`)
    expect(page).toContain('revealButtonRef.value?.focus()')
  })

  it.concurrent('animates the waiting state and keeps reused-key info as a final footnote', () => {
    const page = readFileSync(pagePath, 'utf8')
    const waitingStatus = page.indexOf('d-loading d-loading-dots')
    const reusedFootnote = page.indexOf(`t('cli-login-reused')`)
    const readyStateEnd = page.indexOf(`      </div>\n\n      <div v-else-if="state === 'success'"`)

    expect(waitingStatus).toBeGreaterThanOrEqual(0)
    expect(reusedFootnote).toBeGreaterThan(waitingStatus)
    expect(reusedFootnote).toBeLessThan(readyStateEnd)
    expect(page).toContain('text-xs text-slate-400')
    expect(page).toContain('<span aria-hidden="true">*</span>')
    expect(page).toContain('<output v-if="!aiMode"')
    expect(page).not.toContain('<p v-if="!aiMode" role="status"')
  })

  it.concurrent('keeps the full revealed key visible without truncation', () => {
    const page = readFileSync(pagePath, 'utf8')
    expect(page).toContain('whitespace-normal break-all')
    expect(page).not.toContain('flex-1 truncate')
  })

  it.concurrent('gates key preparation strictly in non-AI mode', () => {
    const page = readFileSync(pagePath, 'utf8')
    expect(page).toContain('const session = route.query.session')
    expect(page).toContain('if (!aiMode.value && !isValidCliLoginSession(session))')
    expect(page.indexOf('if (!aiMode.value && !isValidCliLoginSession(session))'))
      .toBeLessThan(page.indexOf('prepareCliLoginKey('))
  })

  it.concurrent('supports a direct AI setup prompt containing the prepared key', () => {
    const page = readFileSync(pagePath, 'utf8')
    expect(page).toContain(`const aiMode = computed(() => route.query.ai === '1')`)
    expect(page).toContain('buildCliAiSetupPrompt({')
    expect(page).toContain('organizationStore.getAppsByOrgId(organization.gid)')
    expect(page).toContain('eligibleIds.has(organization.gid)')
    expect(page).toContain('await navigator.clipboard.writeText(aiPrompt.value)')
    expect(page).toContain(`v-if="aiMode"`)
    expect(page).toContain(`t('cli-login-ai-copy')`)
  })

  it('copies a prompt containing the prepared key in AI mode', async () => {
    const container = mountLoginCliPage()
    await flushPromises()

    const copyButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes(messages['cli-login-ai-copy']))
    expect(copyButton).toBeDefined()

    copyButton?.click()
    await flushPromises()

    expect(clipboardWrite).toHaveBeenCalledOnce()
    const copiedPrompt = clipboardWrite.mock.calls[0]?.[0] as string
    expect(copiedPrompt).toContain(`login ${preparedKey}`)
    expect(copiedPrompt).toContain('Organization: "Test organization" (organization ID: `org-1`)')
    expect(copiedPrompt).toContain('App: "Test App" (Capgo app ID: `com.test.app`)')
    expect(copiedPrompt).toContain('## 8. Test the first live update')
    expect(copiedPrompt.match(new RegExp(preparedKey, 'g'))).toHaveLength(1)
  })

  it.concurrent('keeps the route out of normal onboarding redirects', () => {
    expect(auth).toContain(`const isCliLoginRoute = to.path === '/login-cli'`)
    expect(auth.match(/if \(isCliLoginRoute\)/g)).toHaveLength(3)
  })

  it.concurrent('defers organization image signing on the CLI login route', () => {
    expect(auth).toContain('const organizationFetchOptions = { loadImages: !isCliLoginRoute }')
    expect(auth).toContain('organizationStore.fetchOrganizations(organizationFetchOptions)')
    expect(auth).toContain('organizationStore.dedupFetchOrganizations(organizationFetchOptions)')
    expect(organizationStoreSource).not.toContain('let loadOrganizationImages')
    expect(organizationStoreSource).toContain('const loadImages = options.loadImages ?? true')
    expect(organizationStoreSource).toContain('loadOrganizationApps(selectableOrganizations, loadImages)')
    expect(organizationStoreSource).toContain('loadPendingOrganizationImages()')
    expect(organizationStoreSource).toContain('if (pendingOrganizationImageLoad)')
    expect(organizationStoreSource).toContain('pendingOrganizationImageLoadRequested = true')
    expect(organizationStoreSource).toContain('if (pendingOrganizationImageLoadRequested)')
  })

  it.concurrent('contains focused key, paste, warning, waiting, and success copy', () => {
    expect(messages['cli-login-direct-description']).toContain(`{'@'}capgo/cli{'@'}latest`)
    expect(messages['cli-login-paste-instruction']).toContain('terminal')
    expect(messages['cli-login-security-warning']).toContain('trust')
    expect(messages['cli-login-copy-note']).toContain('hidden')
    expect(messages['cli-login-waiting']).toContain('Waiting')
    expect(messages['cli-login-success-title']).toContain('successful')
    expect(messages['cli-login-ai-description']).toContain('AI assistant')
    expect(messages['cli-login-ai-security-warning']).toContain('API key')
    expect(messages).not.toHaveProperty('cli-login-ai-prompt')
  })

  it.concurrent('uses prefixed DaisyUI primitives and resolves the destination before success', () => {
    const page = readFileSync(pagePath, 'utf8')
    const resolveDestination = page.indexOf('destination.value = await resolveDestination()')
    const assignSuccess = page.indexOf(`state.value = 'success'`)

    expect(page).toContain('class="d-btn')
    expect(page).toContain('class="d-alert')
    expect(page).not.toMatch(/class="(?:btn|alert)(?:\s|")/)
    expect(resolveDestination).toBeGreaterThanOrEqual(0)
    expect(assignSuccess).toBeGreaterThanOrEqual(0)
    expect(resolveDestination).toBeLessThan(assignSuccess)
  })
})
