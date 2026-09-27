import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { pushEventForUserMock } = vi.hoisted(() => ({
  pushEventForUserMock: vi.fn(),
}))

vi.mock('~/services/posthog', () => ({
  pushEventForUser: pushEventForUserMock,
}))

vi.mock('~/services/supabase', () => ({
  getLocalConfig: () => ({ supaHost: 'https://sb.capgo.app' }),
}))

const { captureOrganizationInvitationSkipped } = await import('../src/services/organizationInvitationTelemetry.ts')

describe('organization invitation client telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('records skip with the authenticated Capgo UUID and no invitation identifiers', () => {
    captureOrganizationInvitationSkipped('550e8400-e29b-41d4-a716-446655440000', 3)

    expect(pushEventForUserMock).toHaveBeenCalledWith(
      'organization_membership_invitation_skipped',
      '550e8400-e29b-41d4-a716-446655440000',
      'https://sb.capgo.app',
      {
        account_state: 'already_existed',
        entry_path: '/onboarding/invitation',
        flow: 'authenticated_pending_invite',
        pending_invitation_count: 3,
      },
    )
  })

  it.concurrent('routes state-changing pending-invite actions through the backend', () => {
    const source = readFileSync(new URL('../src/pages/onboarding/invitation.vue', import.meta.url), 'utf8')

    expect(source).toContain('invokeCapgoApi(\'private/organization_invitation\'')
    expect(source).toContain('action: \'accept\'')
    expect(source).toContain('action: \'decline\'')
    expect(source).toContain('action: \'decline_all\'')
    expect(source).toContain('inviteOrgIds.slice(offset, offset + 100)')
    expect(source).toContain('captureOrganizationInvitationSkipped(userId, invitations.value.length)')
    expect(source).not.toContain('supabase.rpc(\'accept_invitation_to_org\'')
  })

  it.concurrent('routes magic-link viewed telemetry through the anonymous backend endpoint', () => {
    const source = readFileSync(new URL('../src/pages/invitation.vue', import.meta.url), 'utf8')

    expect(source).toContain('invokeCapgoApi(\'private/organization_invitation/magic-view\'')
    expect(source).toContain('allowAnonymous: true')
  })
})
