// @vitest-environment happy-dom
import type { App } from 'vue'
import { getNode } from '@formkit/core'
import { defaultConfig, plugin } from '@formkit/vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '../messages/en.json'
import AppleSignInButton from '../src/components/auth/AppleSignInButton.vue'
import DeleteAccountPage from '../src/pages/delete_account.vue'

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  getClaims: vi.fn(),
  signOut: vi.fn(),
  invoke: vi.fn(),
  errorCode: vi.fn(),
  rpc: vi.fn(),
  assurance: vi.fn(),
  listFactors: vi.fn(),
  challenge: vi.fn(),
  verify: vi.fn(),
  openDialog: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
  captchaReset: vi.fn(),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ replace: mocks.replace, push: mocks.push }) }))
vi.mock('vue-sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('~/services/nativeAppleLogin', () => ({ isNativeAppleLoginAvailable: () => true, signInWithApple: mocks.signIn }))
vi.mock('~/services/capgoApi', () => ({ invokeCapgoApi: mocks.invoke, getCapgoApiErrorCode: mocks.errorCode }))
vi.mock('~/services/emailOtp', () => ({ getRecentEmailOtpVerification: async () => ({ isVerified: true }) }))
vi.mock('~/services/loader', () => ({ hideLoader: vi.fn() }))
vi.mock('~/services/support', () => ({ openSupport: vi.fn() }))
vi.mock('~/utils/turnstile', () => ({ safeResetTurnstile: mocks.captchaReset }))
vi.mock('~/stores/dialogv2', () => ({ useDialogV2Store: () => ({ openDialog: mocks.openDialog, onDialogDismiss: async () => false }) }))
vi.mock('~/services/supabase', () => ({ useSupabase: () => ({
  from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'apple-user' } }) }) }) }),
  rpc: mocks.rpc,
  auth: {
    getClaims: mocks.getClaims,
    getSession: async () => ({ data: { session: { user: { id: 'apple-user', email_confirmed_at: '2026-01-01', identities: [{ provider: 'apple' }] } } } }),
    signOut: mocks.signOut,
    mfa: { getAuthenticatorAssuranceLevel: mocks.assurance, listFactors: mocks.listFactors, challenge: mocks.challenge, verify: mocks.verify },
  },
}) }))
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
  app = createApp(DeleteAccountPage)
  app.use(plugin, defaultConfig())
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } }))
  app.component('AuthPageShell', defineComponent({
    setup(_, { slots }) {
      return () => h('div', slots.default?.())
    },
  }))
  app.component('AppleSignInButton', AppleSignInButton)
  for (const name of ['Spinner', 'CapgoLoader', 'RouterLink', 'LangSelector'])
    app.component(name, { render: () => h('span') })
  app.mount(root)
  await settle()
  return root
}
async function start(root: HTMLElement) {
  ;(root.querySelector('[data-test="apple-sign-in"]') as HTMLButtonElement).click()
  await settle()
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.getClaims.mockResolvedValue({ data: { claims: { sub: 'apple-user' } }, error: null })
  mocks.signIn.mockResolvedValue({ user: { id: 'apple-user' }, authorizationCode: 'fresh-code' })
  mocks.signOut.mockResolvedValue({ error: null })
  mocks.assurance.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null })
  mocks.listFactors.mockResolvedValue({ data: { all: [{ id: 'factor', status: 'verified' }] }, error: null })
  mocks.challenge.mockResolvedValue({ data: { id: 'challenge' }, error: null })
  mocks.verify.mockResolvedValue({ error: null })
  mocks.invoke.mockResolvedValue({ error: null })
  mocks.errorCode.mockResolvedValue(undefined)
  mocks.rpc.mockResolvedValue({ error: null })
})
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
})

describe('apple account deletion', () => {
  it('reauthenticates and revokes Apple access before scheduling deletion without a password', async () => {
    const root = await mount()
    expect(root.querySelector('input[type="password"]')).toBeNull()
    await start(root)
    expect(mocks.signIn).toHaveBeenCalledWith(expect.anything(), undefined, { reauthenticate: true })
    expect(mocks.captchaReset).toHaveBeenCalled()
    await mocks.openDialog.mock.calls[0][0].buttons[0].handler()
    expect(mocks.invoke).toHaveBeenCalledWith('private/revoke_apple_authorization', expect.objectContaining({ body: { code: 'fresh-code' } }))
    expect(mocks.rpc).toHaveBeenCalledWith('delete_user')
    expect(mocks.invoke.mock.invocationCallOrder[0]).toBeLessThan(mocks.rpc.mock.invocationCallOrder[0])
  })
  it('does not delete or revoke when Apple authenticates a different account', async () => {
    mocks.signIn.mockResolvedValue({ user: { id: 'different-user' }, authorizationCode: 'different-code' })
    await start(await mount())
    expect(mocks.signOut).toHaveBeenCalled()
    expect(mocks.openDialog).not.toHaveBeenCalled()
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('leaves the account intact if revocation fails', async () => {
    mocks.invoke.mockResolvedValue({ error: new Error('Upstream unavailable') })
    await start(await mount())
    await mocks.openDialog.mock.calls[0][0].buttons[0].handler()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('requires enrolled MFA before opening deletion confirmation', async () => {
    mocks.assurance.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null })
    const root = await mount()
    await start(root)
    expect(root.querySelector('input[name="code"]')?.getAttribute('autocomplete')).toBe('one-time-code')
    expect(mocks.challenge).toHaveBeenCalledWith({ factorId: 'factor' })
    expect(mocks.openDialog).not.toHaveBeenCalled()
    await getNode('delete-account')!.input({ code: '123456' })
    getNode('delete-account')!.submit()
    await settle()
    await vi.waitFor(() => expect(mocks.verify).toHaveBeenCalledWith({ factorId: 'factor', challengeId: 'challenge', code: '123456' }))
    expect(mocks.openDialog).toHaveBeenCalledOnce()
  })
  it('returns quietly after cancellation and resets the CAPTCHA for another attempt', async () => {
    mocks.signIn.mockResolvedValue(null)
    const root = await mount()
    await start(root)
    expect(mocks.openDialog).not.toHaveBeenCalled()
    expect(mocks.captchaReset).toHaveBeenCalled()
    expect((root.querySelector('[data-test="apple-sign-in"]') as HTMLButtonElement).disabled).toBe(false)
  })
  it.each(['mfa_challenge_expired', 'mfa_ip_address_mismatch', 'mfa_factor_not_found', 'exception'])('restarts Apple authorization after %s', async (failure) => {
    mocks.assurance.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null })
    if (failure !== 'exception')
      mocks.verify.mockResolvedValue({ error: { code: failure } })
    else
      mocks.verify.mockRejectedValue(new Error('Network unavailable'))
    const root = await mount()
    await start(root)
    await getNode('delete-account')!.input({ code: '123456' })
    getNode('delete-account')!.submit()
    await vi.waitFor(() => expect(root.querySelector('[data-test="apple-sign-in"]')).not.toBeNull())
    expect(mocks.openDialog).not.toHaveBeenCalled()
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
    mocks.assurance.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null })
    mocks.signIn.mockResolvedValue({ user: { id: 'apple-user' }, authorizationCode: 'new-code' })
    await start(root)
    await mocks.openDialog.mock.calls[0][0].buttons[0].handler()
    expect(mocks.invoke).toHaveBeenCalledWith('private/revoke_apple_authorization', expect.objectContaining({ body: { code: 'new-code' } }))
  })
  it('keeps the challenge so a mistyped MFA code can be retried', async () => {
    mocks.assurance.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null })
    mocks.verify.mockResolvedValueOnce({ error: { code: 'mfa_verification_failed' } })
    const root = await mount()
    await start(root)
    await getNode('delete-account')!.input({ code: '000000' })
    getNode('delete-account')!.submit()
    await vi.waitFor(() => expect(mocks.verify).toHaveBeenCalledOnce())
    await settle()
    expect(root.querySelector('[data-test="apple-sign-in"]')).toBeNull()
    expect(mocks.openDialog).not.toHaveBeenCalled()
    await getNode('delete-account')!.input({ code: '123456' })
    getNode('delete-account')!.submit()
    await vi.waitFor(() => expect(mocks.openDialog).toHaveBeenCalledOnce())
    expect(mocks.signIn).toHaveBeenCalledOnce()
    expect(mocks.verify).toHaveBeenLastCalledWith({ factorId: 'factor', challengeId: 'challenge', code: '123456' })
  })
  it('explains how to retry when Apple authorization expires before revocation', async () => {
    mocks.invoke.mockResolvedValue({ error: new Error('Fresh Apple sign-in required') })
    mocks.errorCode.mockResolvedValue('reauth_required')
    const root = await mount()
    await start(root)
    await mocks.openDialog.mock.calls[0][0].buttons[0].handler()
    await settle()
    expect(root.textContent).toContain(messages['apple-delete-reauth-required'])
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

})
