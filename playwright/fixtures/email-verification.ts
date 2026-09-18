import type { Session } from '@supabase/supabase-js'
import { defaultConfig, plugin } from '@formkit/vue'
import { createPinia } from 'pinia'
import { createApp, defineComponent, h } from 'vue'
import { createRouter, createWebHistory, RouterView } from 'vue-router'
import { Toaster } from 'vue-sonner'
import { i18n } from '../../src/modules/i18n'
import { useSupabase } from '../../src/services/supabase'
import '../../src/styles/style.css'

const state = {
  sendError: null as { code: string, message: string, status: number } | null,
  sendDelayMs: 0,
  sends: [] as string[],
  verificationError: false,
  verifications: [] as string[],
}
Object.assign(window, { emailVerificationPreview: state })

// Isolate the real page from external services; no emails or API writes occur.
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const verifying = url.includes('/verify_email_otp')
  if (verifying)
    state.verifications.push(JSON.parse(String(init?.body)).token)
  const failed = verifying && state.verificationError
  return new Response(JSON.stringify(verifying
    ? failed ? { message: 'Invalid verification code' } : { verified_at: new Date().toISOString() }
    : { email_otp_verified_at: null }), {
    status: failed ? 400 : 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
const supabase = useSupabase()
supabase.auth.getSession = async () => ({ data: { session: {
  access_token: 'fixture-token',
  user: { id: '00000000-0000-4000-8000-000000000001', email: 'verification-preview@example.com' },
} as Session }, error: null })
supabase.auth.signInWithOtp = async () => {
  state.sends.push('send')
  if (state.sendDelayMs)
    await new Promise(resolve => setTimeout(resolve, state.sendDelayMs))
  return { data: { user: null, session: null }, error: state.sendError as any }
}
supabase.functions.invoke = async (_, options) => {
  state.verifications.push((options?.body as { token: string }).token)
  return state.verificationError
    ? { data: null, error: new Error('Invalid verification code') }
    : { data: { verified_at: new Date().toISOString() }, error: null }
}

// A deterministic widget exercises the page's CAPTCHA transitions in the browser.
const widgets = new Map<string, { element: HTMLElement, input: HTMLInputElement }>()
Object.assign(window, { turnstile: {
  render(element: HTMLElement | null, options: { callback: (token: string) => void }) {
    if (!element)
      return 'unmounted-fixture-widget'
    const id = `fixture-widget-${widgets.size}`
    const label = document.createElement('label')
    label.className = 'flex items-center gap-3 rounded border border-slate-300 bg-slate-50 p-4 text-slate-900'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.setAttribute('aria-label', 'Verify you are human')
    input.addEventListener('change', () => {
      if (input.checked)
        options.callback('fixture-captcha-token')
    })
    label.append(input, 'Verify you are human')
    element.append(label)
    widgets.set(id, { element, input })
    return id
  },
  reset() {
    widgets.forEach(widget => widget.input.checked = false)
  },
  remove(id: string) {
    widgets.get(id)?.element.replaceChildren()
    widgets.delete(id)
  },
} })

async function mountPreview() {
  const { default: ResendEmailPage } = await import('../../src/pages/resend_email.vue')
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/playwright/fixtures/email-verification.html', component: ResendEmailPage },
      { path: '/settings/account', component: { render: () => h('h1', 'Account settings') } },
      { path: '/login', component: { render: () => h('h1', 'Login') } },
    ],
  })
  const app = createApp(defineComponent({ setup: () => () => [h(RouterView), h(Toaster)] }))
  app.use(createPinia())
  app.use(plugin, defaultConfig())
  app.use(i18n)
  app.use(router)
  await router.isReady()
  app.mount('#app')
}

void mountPreview()
