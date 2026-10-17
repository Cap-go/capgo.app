import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { pushEventForUserMock } = vi.hoisted(() => ({
  pushEventForUserMock: vi.fn(),
}))

vi.mock('~/services/posthog', () => ({
  pushEventForUser: pushEventForUserMock,
}))

vi.mock('~/services/console', () => ({
  getLocalConfig: () => ({ supaHost: 'https://sb.capgo.app' }),
}))

const {
  captureOrganizationInvitationEvent,
  runTrackedOrganizationInvitationMutation,
} = await import('../src/services/organizationInvitationTelemetry.ts')

const USER_ID = '550e8400-e29b-41d4-a716-446655440000'
const INVITATION_ID = '71'

describe('organization invitation client telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('records authenticated viewed and skipped events with the Capgo UUID', () => {
    captureOrganizationInvitationEvent({
      event: 'organization_membership_invitation_viewed',
      pendingInvitationCount: 3,
      userId: USER_ID,
    })
    captureOrganizationInvitationEvent({
      event: 'organization_membership_invitation_skipped',
      pendingInvitationCount: 3,
      userId: USER_ID,
    })

    expect(pushEventForUserMock).toHaveBeenNthCalledWith(
      1,
      'organization_membership_invitation_viewed',
      USER_ID,
      'https://sb.capgo.app',
      {
        account_state: 'already_existed',
        entry_path: '/onboarding/invitation',
        flow: 'authenticated_pending_invite',
        pending_invitation_count: 3,
      },
    )
    expect(pushEventForUserMock).toHaveBeenNthCalledWith(
      2,
      'organization_membership_invitation_skipped',
      USER_ID,
      'https://sb.capgo.app',
      expect.objectContaining({ pending_invitation_count: 3 }),
    )
  })

  it('emits accepted only after the membership mutation succeeds', async () => {
    let membershipFinalized = false
    pushEventForUserMock.mockImplementation(() => {
      expect(membershipFinalized).toBe(true)
    })

    await runTrackedOrganizationInvitationMutation({
      failureReason: 'acceptance_failed',
      pendingInvitationCount: 2,
      successEvent: 'organization_membership_invitation_accepted',
      userId: USER_ID,
    }, async () => {
      membershipFinalized = true
      return INVITATION_ID
    })

    expect(pushEventForUserMock).toHaveBeenCalledWith(
      'organization_membership_invitation_accepted',
      USER_ID,
      'https://sb.capgo.app',
      expect.objectContaining({
        $insert_id: expect.stringContaining(`${USER_ID}:${INVITATION_ID}`),
        pending_invitation_count: 2,
      }),
    )
  })

  it('emits declined only after the invitation deletion succeeds', async () => {
    let invitationDeleted = false
    pushEventForUserMock.mockImplementation(() => {
      expect(invitationDeleted).toBe(true)
    })

    await runTrackedOrganizationInvitationMutation({
      failureReason: 'decline_failed',
      pendingInvitationCount: 1,
      successEvent: 'organization_membership_invitation_declined',
      userId: USER_ID,
    }, async () => {
      invitationDeleted = true
      return INVITATION_ID
    })

    expect(pushEventForUserMock).toHaveBeenCalledWith(
      'organization_membership_invitation_declined',
      USER_ID,
      'https://sb.capgo.app',
      expect.objectContaining({
        $insert_id: expect.any(String),
        pending_invitation_count: 1,
      }),
    )
  })

  it('emits only a sanitized failure when membership acceptance fails', async () => {
    await expect(runTrackedOrganizationInvitationMutation({
      failureReason: 'acceptance_failed',
      pendingInvitationCount: 2,
      successEvent: 'organization_membership_invitation_accepted',
      userId: USER_ID,
    }, async () => {
      throw Object.assign(new Error('private invitee@example.com details'), { code: 'ROLE_NOT_FOUND' })
    })).rejects.toThrow()

    expect(pushEventForUserMock).toHaveBeenCalledTimes(1)
    expect(pushEventForUserMock).toHaveBeenCalledWith(
      'organization_membership_invitation_failed',
      USER_ID,
      'https://sb.capgo.app',
      expect.objectContaining({ failure_reason: 'membership_update_failed' }),
    )
    expect(JSON.stringify(pushEventForUserMock.mock.calls)).not.toContain('invitee@example.com')
    expect(pushEventForUserMock).not.toHaveBeenCalledWith(
      'organization_membership_invitation_accepted',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
  })

  it('uses a deterministic insert id and ignores PostHog failures', async () => {
    const input = {
      failureReason: 'acceptance_failed' as const,
      pendingInvitationCount: 1,
      successEvent: 'organization_membership_invitation_accepted' as const,
      userId: USER_ID,
    }

    await runTrackedOrganizationInvitationMutation(input, async () => INVITATION_ID)
    await runTrackedOrganizationInvitationMutation(input, async () => INVITATION_ID)
    await runTrackedOrganizationInvitationMutation(input, async () => '72')

    const firstInsertId = pushEventForUserMock.mock.calls[0][3].$insert_id
    const secondInsertId = pushEventForUserMock.mock.calls[1][3].$insert_id
    const newInvitationInsertId = pushEventForUserMock.mock.calls[2][3].$insert_id
    expect(firstInsertId).toBe(secondInsertId)
    expect(newInvitationInsertId).not.toBe(firstInsertId)

    pushEventForUserMock.mockImplementation(() => {
      throw new Error('PostHog unavailable')
    })
    await expect(runTrackedOrganizationInvitationMutation(input, async () => INVITATION_ID)).resolves.toBeUndefined()
  })

  it('keeps authenticated mutations in the frontend and uses one backend magic lookup', () => {
    const authenticatedSource = readFileSync(new URL('../src/pages/onboarding/invitation.vue', import.meta.url), 'utf8')
    const magicLinkSource = readFileSync(new URL('../src/pages/invitation.vue', import.meta.url), 'utf8')

    expect(authenticatedSource).toContain("supabase.rpc('accept_invitation_to_org'")
    expect(authenticatedSource).toContain(".from('org_users')")
    expect(authenticatedSource).not.toContain("invokeCapgoApi('private/organization_invitation'")
    expect(authenticatedSource).toContain('organization_membership_invitation_declined')
    expect(authenticatedSource).toContain('organization_membership_invitation_skipped')

    expect(magicLinkSource).toContain("'private/organization_invitation/magic-lookup'")
    expect(magicLinkSource).toContain('allowAnonymous: true')
    expect(magicLinkSource).not.toContain("supabase.rpc('get_invite_by_magic_lookup'")
  })
})
