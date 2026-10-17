// @vitest-environment happy-dom
import type { App } from 'vue'
import { defaultConfig, plugin } from '@formkit/vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '../messages/en.json'
import AppleSignInButton from '../src/components/auth/AppleSignInButton.vue'
import LoginPage from '../src/pages/login.vue'
import { prepareAppleOAuthLanding } from '../src/services/appleOAuth'

const mocks = vi.hoisted(() => ({
  available: true,
  signIn: vi.fn(),
  replace: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  getClaims: vi.fn(),
  rpc: vi.fn(),
  signOut: vi.fn(),
  listFactors: vi.fn(),
  challenge: vi.fn(),
  verify: vi.fn(),
  setSession: vi.fn(),
  fullPath: '/login',
  assign: vi.fn(),
}))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => mocks.available } }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: { to: '/apps' }, fullPath: mocks.fullPath, hash: '' }),
  useRouter: () => ({ replace: mocks.replace }),
}))
vi.mock('vue-sonner', () => ({ toast: { error: mocks.error, warning: mocks.warning, success: vi.fn() } }))
vi.mock('~/services/nativeAppleLogin', () => ({ isNativeAppleLoginAvailable: () => mocks.available, signInWithApple: mocks.signIn }))
vi.mock('~/services/console', () => ({
  defaultApiHost: 'https://api.example.test',
  hashEmail: async () => 'hashed-email',
  autoAuth: vi.fn(),
  useConsole: () => ({
    rpc: mocks.rpc,
    auth: {
      getClaims: mocks.getClaims,
      getSession: async () => ({ data: { session: null } }),
      signOut: mocks.signOut,
      setSession: mocks.setSession,
      mfa: { listFactors: mocks.listFactors, challenge: mocks.challenge, verify: mocks.verify },
    },
  }),
}))
vi.mock('~/services/loader', () => ({ hideLoader: vi.fn() }))
vi.mock('~/services/support', () => ({ openSupport: vi.fn() }))

let app: App | undefined
async function settle() {
  for (let i = 0; i < 15; i++) {
    await Promise.resolve()
    await nextTick()
  }
}
async function mount() {
  const root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(LoginPage)
  app.use(plugin, defaultConfig())
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } }))
  app.component('AppleSignInButton', AppleSignInButton)
  for (const name of ['LangSelector', 'CapgoWordtype', 'Spinner'])
    app.component(name, { render: () => h('span') })
  app.component('RouterLink', { render: () => h('a') })
  app.mount(root)
  await settle()
  return root
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.available = true
  mocks.getClaims.mockResolvedValue({ data: { claims: null } })
  mocks.fullPath = '/login'
  sessionStorage.clear()
  vi.stubEnv('DEV', true)
  vi.stubEnv('VITE_WEB_APPLE_LOGIN_ENABLED', 'false')
  mocks.signIn.mockResolvedValue({ user: { id: 'apple-user', email: 'apple@example.com' } })
  mocks.rpc.mockResolvedValue({ data: true, error: null })
  mocks.signOut.mockResolvedValue({ error: null })
  mocks.setSession.mockResolvedValue({ data: { session: { user: { id: 'apple-user', email: 'apple@example.com' } } }, error: null })
  mocks.listFactors.mockResolvedValue({ data: { all: [] }, error: null })
  mocks.challenge.mockResolvedValue({ data: { id: 'challenge-id' }, error: null })
  mocks.verify.mockResolvedValue({ error: null })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ has_sso: false }) })))
})
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('native Apple login page', () => {
  it('reports a deferred Apple callback failure and continues checking the saved session', async () => {
    history.replaceState({}, '', '/login#apple_error=cancelled&state=foreign')
    prepareAppleOAuthLanding()
    await mount()
    expect(mocks.error).toHaveBeenCalledWith(messages['apple-login-failed'])
    expect(mocks.getClaims).toHaveBeenCalledOnce()
  })

  it.each(['rejected', 'network'])('reports failed website-entry Apple starts (%s) and continues saved-session bootstrap', async (failure) => {
    mocks.available = false
    mocks.fullPath = '/login?apple_oauth=1'
    vi.stubEnv('VITE_WEB_APPLE_LOGIN_ENABLED', 'true')
    vi.stubGlobal('location', { origin: 'https://localhost:5173', protocol: 'https:', href: 'https://localhost:5173/login?apple_oauth=1', assign: mocks.assign })
    vi.stubGlobal('history', { replaceState: vi.fn() })
    if (failure === 'network')
      vi.mocked(fetch).mockRejectedValue(new Error('Network unavailable'))
    else
      vi.mocked(fetch).mockResolvedValue(Response.json({ error: 'apple_unavailable' }, { status: 503 }))

    const root = await mount()

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledWith(messages['apple-login-failed']))
    expect(mocks.getClaims).toHaveBeenCalledOnce()
    expect((root.querySelector('[data-test="apple-sign-in"]') as HTMLButtonElement).disabled).toBe(false)
    expect(mocks.assign).not.toHaveBeenCalled()
    expect(mocks.setSession).not.toHaveBeenCalled()
  })

  it.each([false, true])('warns only for a real profile save failure (%s), not an unavailable optional name', async (profileSaveFailed) => {
    mocks.signIn.mockResolvedValue({ user: { id: 'apple-user', email: 'apple@example.com' }, nameUnavailable: true, profileSaveFailed })
    const root = await mount()
    ;(root.querySelector('[data-test="apple-sign-in"]') as HTMLButtonElement).click()
    await settle()
    if (profileSaveFailed)
      expect(mocks.warning).toHaveBeenCalledWith(messages['apple-login-name-save-failed'])
    else
      expect(mocks.warning).not.toHaveBeenCalled()
  })

  async function mountOAuthCallback() {
    mocks.available = false
    const state = 's'.repeat(43)
    sessionStorage.setItem('capgo.apple-oauth.v1', JSON.stringify({ state, verifier: 'v'.repeat(43), created: Date.now() }))
    mocks.fullPath = `/login#apple_code=${'c'.repeat(43)}&state=${state}`
    vi.mocked(fetch).mockResolvedValue(Response.json({ user: { id: 'apple-user', email: 'apple@example.com' }, session: { access_token: 'access', refresh_token: 'refresh' } }))
    return mount()
  }

  it('enters the existing MFA challenge after browser OAuth session installation', async () => {
    mocks.listFactors.mockResolvedValue({ data: { all: [{ id: 'factor-id', status: 'verified' }] }, error: null })
    await mountOAuthCallback()
    expect(mocks.setSession).toHaveBeenCalledOnce()
    expect(mocks.challenge).toHaveBeenCalledWith({ factorId: 'factor-id' })
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(mocks.signOut).not.toHaveBeenCalled()
  })

  it.each(['factors', 'challenge'])('signs out the fresh browser OAuth session if MFA %s setup fails', async (stage) => {
    if (stage === 'factors') {
      mocks.listFactors.mockResolvedValue({ data: null, error: new Error('Factors unavailable') })
    }
    else {
      mocks.listFactors.mockResolvedValue({ data: { all: [{ id: 'factor-id', status: 'verified' }] }, error: null })
      mocks.challenge.mockResolvedValue({ data: null, error: new Error('Challenge unavailable') })
    }
    await mountOAuthCallback()
    expect(mocks.setSession).toHaveBeenCalledOnce()
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledWith(messages['apple-login-failed'])
  })

  it.each([true, false])('uses the browser build flag without discovery: DEV=%s', async (development) => {
    mocks.available = false
    vi.stubEnv('DEV', development)
    vi.stubEnv('VITE_WEB_APPLE_LOGIN_ENABLED', 'true')
    vi.stubGlobal('location', { origin: 'https://localhost:5173', protocol: 'https:', href: 'https://localhost:5173/login', assign: mocks.assign })
    vi.mocked(fetch).mockImplementation(async () => Response.json({ authorization_url: 'https://appleid.apple.com/auth/authorize' }))
    const root = await mount()
    const button = root.querySelector('[data-test="apple-sign-in"]') as HTMLButtonElement | null
    expect(button).not.toBeNull()
    button!.click()
    await settle()
    await vi.waitFor(() => expect(mocks.assign).toHaveBeenCalledWith('https://appleid.apple.com/auth/authorize'))
    expect(mocks.signIn).not.toHaveBeenCalled()
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/auth/apple/start'))).toHaveLength(1)
    expect(vi.mocked(fetch).mock.calls.some(([url]) => /capabilities|auth\/v1\/settings/.test(String(url)))).toBe(false)
  })

  it('hides the Apple button when the native availability gate is false', async () => {
    mocks.available = false
    const root = await mount()
    expect(root.querySelector('[data-test="apple-sign-in"]')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
  it('signs in without requiring email/password fields and preserves the destination', async () => {
    const root = await mount()
    ;(root.querySelector('[data-test="apple-sign-in"]') as HTMLButtonElement).click()
    await settle()
    expect(mocks.signIn).toHaveBeenCalledOnce()
    expect(mocks.listFactors).toHaveBeenCalledOnce()
    expect(mocks.replace).toHaveBeenCalledWith('/apps')
  })
  it('enters the existing MFA challenge instead of navigating an Apple session straight to the app', async () => {
    mocks.listFactors.mockResolvedValue({ data: { all: [{ id: 'factor-id', status: 'verified' }] }, error: null })
    const root = await mount()
    ;(root.querySelector('[data-test="apple-sign-in"]') as HTMLButtonElement).click()
    await settle()
    expect(mocks.challenge).toHaveBeenCalledWith({ factorId: 'factor-id' })
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(root.querySelector('[data-test="verify"]')?.parentElement?.parentElement?.getAttribute('style') ?? '').not.toContain('display: none')
  })
  it('silently restores the button after cancelling native Apple authorization', async () => {
    mocks.signIn.mockResolvedValue(null)
    const root = await mount()
    const button = root.querySelector('[data-test="apple-sign-in"]') as HTMLButtonElement
    button.click()
    await settle()
    expect(button.disabled).toBe(false)
    expect(mocks.error).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
  })
  it('signs out a fresh Apple session if its domain requires SSO', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ has_sso: true, enforce_sso: true }) } as Response)
    const root = await mount()
    ;(root.querySelector('[data-test="apple-sign-in"]') as HTMLButtonElement).click()
    await settle()
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(mocks.replace).not.toHaveBeenCalled()
  })
  it('signs out a fresh Apple session if the deleted-account check rejects it', async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null })
    const root = await mount()
    ;(root.querySelector('[data-test="apple-sign-in"]') as HTMLButtonElement).click()
    await settle()
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(mocks.replace).not.toHaveBeenCalled()
  })
  it.each(['factors', 'challenge'])('signs out the fresh Apple session if MFA %s setup fails', async (stage) => {
    if (stage === 'factors') {
      mocks.listFactors.mockResolvedValue({ data: null, error: new Error('Factors unavailable') })
    }
    else {
      mocks.listFactors.mockResolvedValue({ data: { all: [{ id: 'factor-id', status: 'verified' }] }, error: null })
      mocks.challenge.mockResolvedValue({ data: null, error: new Error('Challenge unavailable') })
    }
    const root = await mount()
    ;(root.querySelector('[data-test="apple-sign-in"]') as HTMLButtonElement).click()
    await settle()
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledWith(messages['apple-login-failed'])
  })
})
