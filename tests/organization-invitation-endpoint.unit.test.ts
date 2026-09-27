import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  captureInvitationEventMock,
  cloudlogErrMock,
  supabaseAdminMock,
} = vi.hoisted(() => ({
  captureInvitationEventMock: vi.fn(),
  cloudlogErrMock: vi.fn(),
  supabaseAdminMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: cloudlogErrMock,
}))

vi.mock('../supabase/functions/_backend/utils/organization_invitation_posthog.ts', () => ({
  captureOrganizationInvitationPosthogEvent: captureInvitationEventMock,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: supabaseAdminMock,
}))

const { app } = await import('../supabase/functions/_backend/private/organization_invitation.ts')

const USER_ID = '550e8400-e29b-41d4-a716-446655440000'
const FUTURE_USER_ID = '1311385a-996f-4a0c-a758-75377255692a'
const INVITATION_DATA = {
  org_logo: 'organization-logo.png',
  org_name: 'Example organization',
  role: 'org_member',
}

interface ClientOptions {
  existingUser?: { id: string } | null
  identityError?: Error | null
  invitationData?: typeof INVITATION_DATA | null
}

function buildAdminClient(options: ClientOptions = {}) {
  const invitationIdentity = {
    email: 'invitee@example.com',
    future_uuid: FUTURE_USER_ID,
  }

  return {
    rpc: vi.fn(() => ({
      maybeSingle: async () => ({
        data: options.invitationData === undefined ? INVITATION_DATA : options.invitationData,
        error: null,
      }),
    })),
    from: vi.fn((table: string) => {
      const chain: any = {
        eq: () => chain,
        maybeSingle: async () => {
          if (table === 'tmp_users') {
            return {
              data: options.identityError ? null : invitationIdentity,
              error: options.identityError ?? null,
            }
          }
          return {
            data: options.existingUser === undefined ? { id: USER_ID } : options.existingUser,
            error: null,
          }
        },
        select: () => chain,
      }
      return chain
    }),
  }
}

function postMagicLookup(magicInviteString = 'secret-invitation-token') {
  return app.request(new Request('http://localhost/magic-lookup', {
    body: JSON.stringify({ magic_invite_string: magicInviteString }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  }))
}

describe('magic-link invitation lookup endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    captureInvitationEventMock.mockResolvedValue(true)
  })

  it('returns the existing lookup data and tracks a new account with its future Capgo UUID', async () => {
    supabaseAdminMock.mockReturnValue(buildAdminClient({ existingUser: null }))

    const response = await postMagicLookup()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(INVITATION_DATA)
    expect(captureInvitationEventMock).toHaveBeenCalledWith(expect.anything(), {
      event: 'organization_membership_invitation_viewed',
      flow: 'new_user_magic_link',
      pendingInvitationCount: 1,
      userId: FUTURE_USER_ID,
    })
  })

  it('tracks an already-existing account using its actual Capgo UUID without exposing PII', async () => {
    supabaseAdminMock.mockReturnValue(buildAdminClient({ existingUser: { id: USER_ID } }))

    const response = await postMagicLookup()

    expect(response.status).toBe(200)
    expect(captureInvitationEventMock).toHaveBeenCalledWith(expect.anything(), {
      event: 'organization_membership_invitation_viewed',
      flow: 'new_user_magic_link',
      pendingInvitationCount: 1,
      userId: USER_ID,
    })
    expect(JSON.stringify(captureInvitationEventMock.mock.calls)).not.toContain('secret-invitation-token')
    expect(JSON.stringify(captureInvitationEventMock.mock.calls)).not.toContain('invitee@example.com')
  })

  it('does not emit viewed for an invalid or expired invitation', async () => {
    supabaseAdminMock.mockReturnValue(buildAdminClient({ invitationData: null }))

    const response = await postMagicLookup('invalid-token')

    expect(response.status).toBe(404)
    expect(captureInvitationEventMock).not.toHaveBeenCalled()
  })

  it('still returns invitation details when telemetry identity lookup fails', async () => {
    supabaseAdminMock.mockReturnValue(buildAdminClient({ identityError: new Error('database unavailable') }))

    const response = await postMagicLookup()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(INVITATION_DATA)
    expect(captureInvitationEventMock).not.toHaveBeenCalled()
    expect(cloudlogErrMock).toHaveBeenCalled()
  })

  it('still returns invitation details when PostHog capture fails', async () => {
    supabaseAdminMock.mockReturnValue(buildAdminClient())
    captureInvitationEventMock.mockRejectedValue(new Error('PostHog unavailable'))

    const response = await postMagicLookup()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(INVITATION_DATA)
  })
})
