import { beforeEach, describe, expect, it, vi } from 'vitest'

const { pushEventForUserMock } = vi.hoisted(() => ({
  pushEventForUserMock: vi.fn(),
}))

vi.mock('~/services/posthog', () => ({
  pushEventForUser: pushEventForUserMock,
}))

vi.mock('~/services/console', () => ({
  getLocalConfig: () => ({ apiHost: 'https://api.capgo.app' }),
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
      'https://api.capgo.app',
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
      'https://api.capgo.app',
      expect.objectContaining({ pending_invitation_count: 3 }),
    )
  })

  it.each([
    ['organization_membership_invitation_accepted', 'acceptance_failed', 2],
    ['organization_membership_invitation_declined', 'decline_failed', 1],
  ] as const)('emits %s only after the mutation succeeds', async (successEvent, failureReason, pendingInvitationCount) => {
    let mutationFinished = false
    pushEventForUserMock.mockImplementation(() => {
      expect(mutationFinished).toBe(true)
    })

    await runTrackedOrganizationInvitationMutation({
      failureReason,
      pendingInvitationCount,
      successEvent,
      userId: USER_ID,
    }, async () => {
      mutationFinished = true
      return INVITATION_ID
    })

    expect(pushEventForUserMock).toHaveBeenCalledWith(
      successEvent,
      USER_ID,
      'https://api.capgo.app',
      expect.objectContaining({
        $insert_id: expect.stringContaining(`${USER_ID}:${INVITATION_ID}`),
        pending_invitation_count: pendingInvitationCount,
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
      'https://api.capgo.app',
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
})
