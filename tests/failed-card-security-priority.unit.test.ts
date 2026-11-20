// @vitest-environment happy-dom

import type { App } from 'vue'
import { createPinia, defineStore } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import FailedCard from '../src/components/FailedCard.vue'

vi.mock('~/services/nativeCompliance', () => ({ isNativeAppStoreContext: () => false }))

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/dashboard' }),
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('vue-sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('~/stores/organization', () => ({
  useOrganizationStore: defineStore('failed-card-org', {
    state: () => ({
      currentOrganization: {
        gid: 'org-security',
        enforcing_2fa: true,
        '2fa_has_access': false,
        password_policy_config: { enabled: true },
        password_has_access: false,
      },
      currentOrganizationFailed: false,
    }),
  }),
}))

const messages = {
  en: {
    '2fa-setup-required': 'Two-factor authentication required',
    'password-policy-required': 'Password policy update required',
    '2fa-setup-org-access': 'Set up 2FA to access this organization',
    'password-update-org-access': 'Update your password to access this organization',
    'setup-2fa-now': 'Set up 2FA',
    'update-password-now': 'Update password',
    'subscription-required': 'Subscription required',
    'plan-failed-description': 'Plan failed',
  },
}

let mounted: App | undefined
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  container.remove()
})

describe('FailedCard security remediation priority', () => {
  it('shows the 2FA setup prompt when both 2FA and password policy are blocking', async () => {
    mounted = createApp(FailedCard)
    mounted.use(createPinia())
    mounted.use(createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false, messages }))
    mounted.mount(container)
    await nextTick()

    expect(container.textContent).toContain('Two-factor authentication required')
    expect(container.textContent).not.toContain('Password policy update required')
  })
})