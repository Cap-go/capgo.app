// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import InvitationPage from '../src/pages/onboarding/invitation.vue'

const mocks = vi.hoisted(() => ({
  userId: '550e8400-e29b-41d4-a716-446655440000',
  invitation: { gid: '550e8400-e29b-41d4-a716-446655440001', name: 'Example organization', is_invite: true },
  rpc: vi.fn(),
  from: vi.fn(),
  capture: vi.fn(),
  fetchOrganizations: vi.fn(),
  setCurrentOrganization: vi.fn(),
  replace: vi.fn(),
  success: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  createI18n: () => ({ global: { t: (key: string) => key }, install: () => {} }),
}))
vi.mock('vue-sonner', () => ({ toast: { success: mocks.success } }))
vi.mock('~/stores/main', () => ({ useMainStore: () => ({ user: { id: mocks.userId } }) }))
vi.mock('~/stores/display', () => ({ useDisplayStore: () => ({}) }))
vi.mock('~/stores/organization', () => ({
  isPendingOrganizationInvite: (org: { is_invite: boolean }) => org.is_invite,
  useOrganizationStore: () => ({
    organizations: [mocks.invitation],
    get hasOrganizations() { return !mocks.invitation.is_invite },
    fetchOrganizations: mocks.fetchOrganizations,
    setCurrentOrganization: mocks.setCurrentOrganization,
  }),
}))
vi.mock('~/services/nativeCompliance', () => ({ isNativeAppStoreContext: () => false }))
vi.mock('~/services/posthog', () => ({ pushEventForUser: mocks.capture }))
vi.mock('~/services/console', () => ({
  getLocalConfig: () => ({ apiHost: 'https://api.capgo.app' }),
  useConsole: () => ({ rpc: mocks.rpc, from: mocks.from }),
}))

let app: ReturnType<typeof createApp> | undefined

async function joinInvitation() {
  const container = document.createElement('div')
  app = createApp(InvitationPage)
  app.mount(container)
  await vi.waitFor(() => expect(container.querySelector('[data-test="pending-invite-join"]')).not.toBeNull())
  container.querySelector<HTMLButtonElement>('[data-test="pending-invite-join"]')!.click()
  for (let i = 0; i < 15; i++) {
    await Promise.resolve()
    await nextTick()
  }
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('useRoute', () => ({ query: {} }))
  vi.stubGlobal('useRouter', () => ({ replace: mocks.replace }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mocks.invitation.is_invite = true
  const hiddenMembership = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  }
  mocks.from.mockReturnValue(hiddenMembership)
  mocks.rpc.mockImplementation(async () => {
    mocks.invitation.is_invite = false
    return { data: 'OK', error: null }
  })
})

afterEach(() => {
  app?.unmount()
  app = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('pending organization invitation acceptance', () => {
  it('joins through the RPC when RLS hides the pending membership row', async () => {
    await joinInvitation()

    expect(mocks.rpc).toHaveBeenCalledWith('accept_invitation_to_org', { org_id: mocks.invitation.gid })
    expect(mocks.from).not.toHaveBeenCalled()
    expect(mocks.setCurrentOrganization).toHaveBeenCalledWith(mocks.invitation.gid)
    expect(mocks.success).toHaveBeenCalledWith('pending-invite-joined')
    expect(mocks.replace).toHaveBeenCalledWith('/dashboard')
    expect(mocks.capture).toHaveBeenCalledWith(
      'organization_membership_invitation_accepted',
      mocks.userId,
      'https://api.capgo.app',
      expect.objectContaining({ pending_invitation_count: 1 }),
    )
  })

  it.each([
    { data: 'NO_INVITE', error: null },
    { data: null, error: new Error('Acceptance failed') },
  ])('keeps the invitation pending when the RPC rejects acceptance: %j', async (response) => {
    mocks.rpc.mockResolvedValue(response)
    const container = await joinInvitation()

    expect(mocks.rpc).toHaveBeenCalledOnce()
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(container.textContent).toContain('pending-invite-join-failed')
    expect(mocks.capture.mock.calls.map(call => call[0])).toContain('organization_membership_invitation_failed')
    expect(mocks.capture.mock.calls.map(call => call[0])).not.toContain('organization_membership_invitation_accepted')
  })
})
