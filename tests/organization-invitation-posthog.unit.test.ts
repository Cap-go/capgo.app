import { beforeEach, describe, expect, it, vi } from 'vitest'

const { cloudlogErrMock, trackPosthogEventMock } = vi.hoisted(() => ({
  cloudlogErrMock: vi.fn(),
  trackPosthogEventMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlogErr: cloudlogErrMock,
}))

vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({
  trackPosthogEvent: trackPosthogEventMock,
}))

const {
  captureOrganizationInvitationPosthogEvent,
  organizationInvitationInsertId,
  sanitizeOrganizationInvitationFailureReason,
} = await import('../supabase/functions/_backend/utils/organization_invitation_posthog.ts')

const context = {
  get: (key: string) => key === 'requestId' ? 'request-id' : undefined,
} as any

describe('organization invitation PostHog events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    trackPosthogEventMock.mockResolvedValue(true)
  })

  it('builds deterministic, opaque insert ids for successful membership changes', async () => {
    const input = {
      event: 'organization_membership_invitation_accepted' as const,
      flow: 'new_user_magic_link' as const,
      invitationId: 451,
      userId: '550e8400-e29b-41d4-a716-446655440000',
    }

    const first = await organizationInvitationInsertId(input)
    const second = await organizationInvitationInsertId(input)

    expect(first).toBe(second)
    expect(first).toMatch(/^organization-invitation:[a-f\d]{64}$/)
    expect(first).not.toContain(input.userId)
    expect(first).not.toContain(String(input.invitationId))
  })

  it('uses the Capgo user UUID and event-only properties without PII', async () => {
    await captureOrganizationInvitationPosthogEvent(context, {
      accountState: 'created',
      event: 'organization_membership_invitation_accepted',
      flow: 'new_user_magic_link',
      invitationId: 451,
      pendingInvitationCount: 1,
      userId: '550e8400-e29b-41d4-a716-446655440000',
    })

    expect(trackPosthogEventMock).toHaveBeenCalledWith(context, expect.objectContaining({
      channel: 'organization-invitation',
      event: 'organization_membership_invitation_accepted',
      setPersonProperties: false,
      user_id: '550e8400-e29b-41d4-a716-446655440000',
    }))
    const payload = trackPosthogEventMock.mock.calls[0][1]
    expect(payload.nonPersonTags).toEqual(expect.objectContaining({
      account_state: 'created',
      entry_path: '/invitation',
      flow: 'new_user_magic_link',
      pending_invitation_count: 1,
      $insert_id: expect.stringMatching(/^organization-invitation:/),
    }))
    expect(JSON.stringify(payload.nonPersonTags)).not.toContain('invitee@example.com')
    expect(JSON.stringify(payload.nonPersonTags)).not.toContain('secret-invitation-token')
  })

  it('reduces arbitrary failures to a fixed safe reason', () => {
    expect(sanitizeOrganizationInvitationFailureReason({ cause: { error: 'SIGN_IN_FAILED' } })).toBe('authentication_failed')
    expect(sanitizeOrganizationInvitationFailureReason('invitee@example.com secret-token', 'acceptance_failed')).toBe('acceptance_failed')
  })

  it('never lets a PostHog exception fail the invitation operation', async () => {
    trackPosthogEventMock.mockRejectedValueOnce(new Error('PostHog unavailable'))

    await expect(captureOrganizationInvitationPosthogEvent(context, {
      event: 'organization_membership_invitation_viewed',
      flow: 'authenticated_pending_invite',
      pendingInvitationCount: 2,
      userId: '550e8400-e29b-41d4-a716-446655440000',
    })).resolves.toBe(false)

    expect(cloudlogErrMock).toHaveBeenCalledOnce()
  })
})
