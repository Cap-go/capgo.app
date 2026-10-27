// @vitest-environment happy-dom
import type { App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '../messages/en.json'
import AccountPage from '../src/pages/settings/account/index.vue'
import { useDialogV2Store } from '../src/stores/dialogv2'

const mocks = vi.hoisted(() => ({
  main: {
    auth: { id: 'account-deletion-user', email: 'account-deletion@example.com' },
    user: undefined,
    plans: [],
    // Accounts without organizations never fetch dashboard statistics.
    awaitInitialLoad: vi.fn(() => new Promise(() => {})),
  },
  organization: {
    organizations: [] as Array<{ gid: string, name: string, role: string }>,
    awaitInitialLoad: vi.fn(),
  },
  verification: vi.fn(),
  push: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock('~/stores/main', () => ({ useMainStore: () => mocks.main }))
vi.mock('~/stores/display', () => ({ useDisplayStore: () => ({}) }))
vi.mock('~/stores/organization', () => ({
  useOrganizationStore: () => mocks.organization,
  isSuperAdminRole: (role: string) => role === 'org_super_admin',
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push: mocks.push }),
}))
vi.mock('~/services/emailOtp', () => ({ getRecentEmailOtpVerification: mocks.verification }))
vi.mock('~/services/console', () => ({
  useConsole: () => ({ rpc: mocks.rpc }),
  isPayingOrg: async () => false,
  getCurrentPlanNameOrg: vi.fn(),
}))
vi.mock('~/services/photos', () => ({ pickPhoto: vi.fn(), takePhoto: vi.fn() }))
vi.mock('~/components/dashboard/GitHubProfileDialog.vue', () => ({ default: { render: () => null } }))

let app: App | undefined

async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

async function clickDeleteAccount() {
  const pinia = createPinia()
  setActivePinia(pinia)
  document.body.innerHTML = '<div id="account-page"></div><div id="dialog-v2-content"></div>'
  app = createApp(AccountPage)
  app.use(pinia)
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } }))
  app.component('Spinner', { render: () => h('span') })
  app.component('LangSelector', { render: () => h('span') })
  app.mount('#account-page')
  await settle()
  const button = Array.from(document.querySelectorAll('button'))
    .find(button => button.textContent?.trim() === messages['delete-account'])!
  button.click()
  await settle()
  return useDialogV2Store()
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.organization.organizations = []
  mocks.organization.awaitInitialLoad.mockResolvedValue(true)
  mocks.verification.mockResolvedValue({ isVerified: true })
  mocks.rpc.mockResolvedValue({ data: [{ role_name: 'org_super_admin', is_invite: false, is_tmp: false }], error: null })
})

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
})

describe('account deletion from settings', () => {
  it('opens the confirmation without dashboard statistics for an account with no organizations', async () => {
    const dialog = await clickDeleteAccount()

    expect(mocks.verification).toHaveBeenCalledWith(expect.anything(), mocks.main.auth.id)
    expect(dialog.showDialog).toBe(true)
    expect(dialog.dialogOptions.id).toBe('delete-account-confirm')
    expect(document.querySelector('#delete-account-password')).not.toBeNull()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('waits for organizations and preserves the organization deletion warning', async () => {
    let finishLoading!: (value: boolean) => void
    mocks.organization.awaitInitialLoad.mockReturnValue(new Promise<boolean>((resolve) => {
      finishLoading = resolve
    }))
    const dialog = await clickDeleteAccount()
    expect(dialog.showDialog).toBe(false)

    mocks.organization.organizations = [{ gid: 'deletion-test-org', name: 'Deletion test organization', role: 'org_super_admin' }]
    finishLoading(true)
    await settle()

    expect(mocks.rpc).toHaveBeenCalledWith('get_org_members_rbac', { p_org_id: 'deletion-test-org' })
    expect(dialog.dialogOptions.id).toBe('delete-account-warning-orgs')
    expect(document.body.textContent).toContain('Deletion test organization')
  })

  it('still requires recent email verification before opening a deletion dialog', async () => {
    mocks.verification.mockResolvedValue({ isVerified: false })
    const dialog = await clickDeleteAccount()

    expect(dialog.showDialog).toBe(false)
    expect(mocks.push).toHaveBeenCalledWith({
      path: '/resend_email',
      query: { reason: 'email_not_verified', return_to: '/settings/account', purpose: 'delete_account' },
    })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})
