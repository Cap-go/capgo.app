// @vitest-environment happy-dom

import type { FormKitNode } from '@formkit/core'
import type { App } from 'vue'
import { getNode } from '@formkit/core'
import { defaultConfig, plugin } from '@formkit/vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '../messages/en.json'
import ResendEmailPage from '../src/pages/resend_email.vue'

const mocks = vi.hoisted(() => ({
  route: { query: {} as Record<string, string> },
  router: { replace: vi.fn() },
  main: { awaitInitialLoad: vi.fn(() => new Promise(() => {})) },
  getSession: vi.fn(),
  resend: vi.fn(),
  getRecentEmailOtpVerification: vi.fn(),
  sendEmailOtpVerification: vi.fn(),
  verifyEmailOtp: vi.fn(),
  resetCaptcha: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => mocks.router,
}))
vi.mock('~/stores/main', () => ({ useMainStore: () => mocks.main }))
vi.mock('~/services/supabase', () => ({
  useSupabase: () => ({ auth: { getSession: mocks.getSession, resend: mocks.resend } }),
}))
vi.mock('~/services/support', () => ({ openSupport: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))
vi.mock('~/services/emailOtp', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/emailOtp')>(),
  getRecentEmailOtpVerification: mocks.getRecentEmailOtpVerification,
  sendEmailOtpVerification: mocks.sendEmailOtpVerification,
  verifyEmailOtp: mocks.verifyEmailOtp,
}))
vi.mock('vue-turnstile', () => ({
  default: defineComponent({
    props: ['modelValue', 'siteKey'],
    emits: ['update:modelValue', 'error', 'unsupported', 'expired'],
    setup(props, { emit, expose }) {
      expose({
        reset() {
          mocks.resetCaptcha()
          emit('update:modelValue', '')
        },
      })
      return () => h('div', [
        h('input', {
          'data-test': 'captcha',
          'data-site-key': props.siteKey,
          'value': props.modelValue,
          'onInput': (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value),
        }),
        ...(['error', 'unsupported', 'expired'] as const).map(event => h('button', {
          type: 'button',
          onClick: () => emit(event),
        }, `CAPTCHA ${event}`)),
      ])
    },
  }),
}))

const apps: App[] = []
const inputs = new Map<string, FormKitNode>()

async function mountPage() {
  const app = createApp(ResendEmailPage)
  app.use(plugin, defaultConfig({
    config: { delay: 0 },
    plugins: [(node) => { inputs.set(node.name, node) }],
  }))
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } }))
  app.component('AuthPageShell', defineComponent({ setup: (_, { slots }) => () => h('main', slots.default?.()) }))
  app.component('RouterLink', defineComponent({ setup: (_, { slots }) => () => h('a', slots.default?.()) }))
  app.component('Spinner', { render: () => h('div', { 'data-test': 'spinner' }) })
  app.component('LangSelector', { render: () => h('div') })
  const container = document.createElement('div')
  document.body.appendChild(container)
  app.mount(container)
  apps.push(app)
  await vi.waitFor(() => expect(container.querySelector('[data-test="spinner"]')).toBeNull())
  await nextTick()
  return container
}

async function completeCaptcha(container: HTMLElement, token = 'test-captcha-token') {
  const input = container.querySelector<HTMLInputElement>('[data-test="captcha"]')!
  input.value = token
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

async function submitResend() {
  const form = getNode('resend-email')!
  await form.input({ email: 'confirmation-test@example.com' })
  form.submit()
  await vi.waitFor(() => expect(form.context?.state.submitted).toBe(true))
  await nextTick()
}

function button(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === text)!
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('VITE_CAPTCHA_KEY', 'test-site-key')
  vi.stubGlobal('turnstile', undefined)
  mocks.route.query = {}
  mocks.getSession.mockResolvedValue({ data: { session: null } })
  mocks.resend.mockResolvedValue({ error: null })
  mocks.getRecentEmailOtpVerification.mockResolvedValue({ isVerified: false })
  mocks.sendEmailOtpVerification.mockResolvedValue({ error: null })
  mocks.verifyEmailOtp.mockResolvedValue({ data: { verified_at: new Date().toISOString() }, error: null })
})

afterEach(() => {
  apps.splice(0).forEach(app => app.unmount())
  document.body.replaceChildren()
  inputs.clear()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('email confirmation CAPTCHA', () => {
  it('renders CAPTCHA on a signed-out verification link without waiting for dashboard data', async () => {
    mocks.route.query = { reason: 'email_not_verified', return_to: '/settings/account' }
    const container = await mountPage()

    expect(container.querySelector('[data-site-key="test-site-key"]')).not.toBeNull()
    expect(container.querySelector('input[type="email"]')).not.toBeNull()
    expect(mocks.getSession).toHaveBeenCalledOnce()
    expect(mocks.main.awaitInitialLoad).not.toHaveBeenCalled()
  })

  it('requires CAPTCHA before resending a signup confirmation', async () => {
    const container = await mountPage()
    await submitResend()

    await vi.waitFor(() => expect(container.textContent).toContain(messages['captcha-required']))
    expect(mocks.resend).not.toHaveBeenCalled()
  })

  it.each(['error', 'unsupported'])('allows the server to handle resend when CAPTCHA emits %s', async (event) => {
    const container = await mountPage()
    await completeCaptcha(container)
    button(container, `CAPTCHA ${event}`).click()
    await nextTick()
    expect(container.textContent).toContain(messages['captcha-resend-unavailable'])
    expect(container.querySelector<HTMLInputElement>('[data-test="captcha"]')?.value).toBe('')

    await submitResend()
    await vi.waitFor(() => expect(mocks.toast.success).toHaveBeenCalledOnce())
    expect(mocks.resend).toHaveBeenCalledWith({
      type: 'signup',
      email: 'confirmation-test@example.com',
      options: { captchaToken: undefined },
    })
  })

  it('allows submitting after the CAPTCHA script fails to initialize', async () => {
    vi.useFakeTimers()
    const container = await mountPage()
    await vi.advanceTimersByTimeAsync(8000)
    await nextTick()
    expect(container.textContent).toContain(messages['captcha-resend-unavailable'])
    vi.useRealTimers()

    await submitResend()
    await vi.waitFor(() => expect(mocks.toast.success).toHaveBeenCalledOnce())
    expect(mocks.resend).toHaveBeenCalledWith(expect.objectContaining({ options: { captchaToken: undefined } }))
  })

  it('keeps requiring a challenge once Turnstile has initialized', async () => {
    vi.stubGlobal('turnstile', {})
    vi.useFakeTimers()
    const container = await mountPage()
    await vi.advanceTimersByTimeAsync(8000)
    await nextTick()
    expect(container.textContent).not.toContain(messages['captcha-resend-unavailable'])
    vi.useRealTimers()

    await submitResend()
    await vi.waitFor(() => expect(container.textContent).toContain(messages['captcha-required']))
    expect(mocks.resend).not.toHaveBeenCalled()
  })

  it('restores normal CAPTCHA requirements when an unavailable widget recovers', async () => {
    const container = await mountPage()
    button(container, 'CAPTCHA error').click()
    await nextTick()
    await completeCaptcha(container, 'recovered-captcha-token')
    expect(container.textContent).not.toContain(messages['captcha-resend-unavailable'])

    await submitResend()
    await vi.waitFor(() => expect(mocks.toast.success).toHaveBeenCalledOnce())
    expect(mocks.resend).toHaveBeenCalledWith(expect.objectContaining({ options: { captchaToken: 'recovered-captcha-token' } }))
    await submitResend()
    await vi.waitFor(() => expect(container.textContent).toContain(messages['captcha-required']))
    expect(mocks.resend).toHaveBeenCalledOnce()
  })

  it('clears an expired token instead of sending it', async () => {
    const container = await mountPage()
    await completeCaptcha(container)
    button(container, 'CAPTCHA expired').click()
    await nextTick()
    await submitResend()

    await vi.waitFor(() => expect(container.textContent).toContain(messages['captcha-required']))
    expect(mocks.resend).not.toHaveBeenCalled()
  })

  it('sends the solved CAPTCHA with the resend request and clears the consumed token', async () => {
    const container = await mountPage()
    await completeCaptcha(container)
    await submitResend()

    await vi.waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith(messages['confirm-email-sent']))
    expect(mocks.resend).toHaveBeenCalledWith({
      type: 'signup',
      email: 'confirmation-test@example.com',
      options: { captchaToken: 'test-captcha-token' },
    })
    expect(mocks.resetCaptcha).toHaveBeenCalledOnce()
    expect(container.querySelector<HTMLInputElement>('[data-test="captcha"]')?.value).toBe('')
  })

  it('requires a fresh challenge after a failed resend and allows retrying', async () => {
    mocks.resend.mockResolvedValueOnce({ error: { message: 'Captcha verification failed' } })
    const container = await mountPage()
    await completeCaptcha(container)
    await submitResend()
    await vi.waitFor(() => expect(container.textContent).toContain('Captcha verification failed'))
    expect(mocks.resetCaptcha).toHaveBeenCalledOnce()
    expect(mocks.toast.error).toHaveBeenCalledWith('Captcha verification failed')
    expect(mocks.toast.error.mock.invocationCallOrder[0]).toBeLessThan(mocks.resetCaptcha.mock.invocationCallOrder[0])

    await submitResend()
    await vi.waitFor(() => expect(container.textContent).toContain(messages['captcha-required']))
    expect(mocks.resend).toHaveBeenCalledOnce()

    await completeCaptcha(container, 'retry-captcha-token')
    await submitResend()
    await vi.waitFor(() => expect(mocks.toast.success).toHaveBeenCalledOnce())
    expect(mocks.resend).toHaveBeenLastCalledWith({
      type: 'signup',
      email: 'confirmation-test@example.com',
      options: { captchaToken: 'retry-captcha-token' },
    })
  })

  it('shows a thrown resend error before resetting and allows retrying with a fresh token', async () => {
    mocks.resend.mockRejectedValueOnce(new Error('Network unavailable'))
    const container = await mountPage()
    await completeCaptcha(container)
    await submitResend()

    await vi.waitFor(() => expect(container.textContent).toContain('Network unavailable'))
    expect(mocks.toast.error).toHaveBeenCalledWith('Network unavailable')
    expect(mocks.toast.error.mock.invocationCallOrder[0]).toBeLessThan(mocks.resetCaptcha.mock.invocationCallOrder[0])
    expect(button(container, messages.resend).disabled).toBe(false)
    expect(container.querySelector<HTMLInputElement>('[data-test="captcha"]')?.value).toBe('')

    await completeCaptcha(container, 'retry-captcha-token')
    await submitResend()
    await vi.waitFor(() => expect(mocks.toast.success).toHaveBeenCalledOnce())
    expect(mocks.resend).toHaveBeenCalledTimes(2)
  })

  it('shows a localized fallback for thrown errors without a message', async () => {
    mocks.resend.mockRejectedValueOnce(null)
    const container = await mountPage()
    await completeCaptcha(container)
    await submitResend()

    await vi.waitFor(() => expect(container.textContent).toContain(messages['confirm-email-send-failed']))
    expect(mocks.toast.error).toHaveBeenCalledWith(messages['confirm-email-send-failed'])
    expect(mocks.resetCaptcha).toHaveBeenCalledOnce()
  })

  it('allows resending when CAPTCHA is disabled', async () => {
    vi.stubEnv('VITE_CAPTCHA_KEY', '')
    const container = await mountPage()
    await submitResend()

    await vi.waitFor(() => expect(mocks.toast.success).toHaveBeenCalledOnce())
    expect(container.querySelector('[data-test="captcha"]')).toBeNull()
    expect(mocks.resend).toHaveBeenCalledWith({
      type: 'signup',
      email: 'confirmation-test@example.com',
      options: { captchaToken: undefined },
    })
  })

  it('loads the signed-in OTP flow without dashboard data and returns to the requested page', async () => {
    mocks.route.query = { reason: 'email_not_verified', return_to: '/settings/account' }
    mocks.getSession.mockResolvedValue({ data: { session: { user: { id: 'test-user', email: 'confirmation-test@example.com' } } } })
    const container = await mountPage()

    expect(container.querySelector('input[type="email"]')).toBeNull()
    expect(mocks.main.awaitInitialLoad).not.toHaveBeenCalled()
    button(container, messages['email-otp-send-code']).click()
    await nextTick()
    expect(mocks.sendEmailOtpVerification).not.toHaveBeenCalled()

    await completeCaptcha(container)
    button(container, messages['email-otp-send-code']).click()
    await vi.waitFor(() => expect(mocks.sendEmailOtpVerification).toHaveBeenCalledWith(expect.anything(), 'confirmation-test@example.com', 'test-captcha-token'))
    expect(mocks.resetCaptcha).toHaveBeenCalledOnce()

    await inputs.get('email_otp')!.input('123456')
    await nextTick()
    button(container, messages['validate-email']).click()
    await vi.waitFor(() => expect(mocks.router.replace).toHaveBeenCalledWith('/settings/account'))
    expect(mocks.verifyEmailOtp).toHaveBeenCalledWith(expect.anything(), '123456')
  })

  it('returns immediately when the signed-in email was recently verified', async () => {
    mocks.route.query = { reason: 'email_not_verified', return_to: '/delete_account' }
    mocks.getSession.mockResolvedValue({ data: { session: { user: { id: 'test-user', email: 'confirmation-test@example.com' } } } })
    mocks.getRecentEmailOtpVerification.mockResolvedValue({ isVerified: true })
    await mountPage()

    expect(mocks.router.replace).toHaveBeenCalledWith('/delete_account')
    expect(mocks.sendEmailOtpVerification).not.toHaveBeenCalled()
  })
})
