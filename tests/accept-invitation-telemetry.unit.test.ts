import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  captureInvitationEventMock,
  closeClientMock,
  createUserMock,
  deleteUserMock,
  emptySupabaseMock,
  getPgClientMock,
  signInMock,
  supabaseAdminMock,
} = vi.hoisted(() => ({
  captureInvitationEventMock: vi.fn(),
  closeClientMock: vi.fn(),
  createUserMock: vi.fn(),
  deleteUserMock: vi.fn(),
  emptySupabaseMock: vi.fn(),
  getPgClientMock: vi.fn(),
  signInMock: vi.fn(),
  supabaseAdminMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
  serializeError: (error: unknown) => JSON.stringify(error),
}))

vi.mock('../supabase/functions/_backend/utils/organization_invitation_posthog.ts', () => ({
  captureOrganizationInvitationPosthogEvent: captureInvitationEventMock,
  sanitizeOrganizationInvitationFailureReason: (_error: unknown, fallback: string) => fallback,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: closeClientMock,
  getPgClient: getPgClientMock,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  emptySupabase: emptySupabaseMock,
  supabaseAdmin: supabaseAdminMock,
}))

vi.mock('../supabase/functions/_backend/utils/user_preferences.ts', () => ({
  syncUserPreferenceTags: vi.fn(),
}))

const { app } = await import('../supabase/functions/_backend/private/accept_invitation.ts')

const FUTURE_USER_ID = '1311385a-996f-4a0c-a758-75377255692a'
const EXISTING_USER_ID = '550e8400-e29b-41d4-a716-446655440000'
const ORG_ID = 'a3d4cb0c-96df-4e65-bca4-b7e037a09017'

const invitation = {
  cancelled_at: null,
  email: 'invitee@example.com',
  first_name: 'Invited',
  future_uuid: FUTURE_USER_ID,
  id: 84,
  invite_magic_string: 'secret-invitation-token',
  last_name: 'User',
  org_id: ORG_ID,
  rbac_role_name: 'org_member',
}

function buildPgPool(acceptStatuses: string[] = ['OK']) {
  let callCount = 0
  const pgClient = {
    query: vi.fn(async (query: string) => {
      if (query.includes('accept_tmp_user_invitation')) {
        const status = acceptStatuses[Math.min(callCount, acceptStatuses.length - 1)]
        callCount += 1
        return { rows: [{ accept_tmp_user_invitation: status }] }
      }
      return { rows: [] }
    }),
    release: vi.fn(),
  }
  return {
    connect: vi.fn(async () => pgClient),
  }
}

function buildAdmin(options: {
  deleteInvitationError?: { message: string } | null
  existingUserId?: string
  invitationAvailable?: { value: boolean }
}) {
  const invitationAvailable = options.invitationAvailable ?? { value: true }

  return {
    auth: {
      admin: {
        createUser: createUserMock,
        deleteUser: deleteUserMock,
      },
    },
    from(table: string) {
      if (table === 'tmp_users') {
        return {
          delete: () => ({
            eq: async () => {
              if (!options.deleteInvitationError)
                invitationAvailable.value = false
              return { error: options.deleteInvitationError ?? null }
            },
          }),
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: invitationAvailable.value ? invitation : null,
                error: null,
              }),
            }),
          }),
        }
      }

      if (table === 'orgs') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { password_policy_config: null }, error: null }),
            }),
          }),
        }
      }

      if (table === 'users') {
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({ data: { id: FUTURE_USER_ID }, error: null }),
            }),
          }),
          select: () => ({
            eq: (column: string) => ({
              maybeSingle: async () => ({
                data: column === 'email' && options.existingUserId ? { id: options.existingUserId } : null,
                error: null,
              }),
            }),
          }),
        }
      }

      throw new Error(`Unexpected table: ${table}`)
    },
  }
}

function acceptRequest() {
  return app.request(new Request('http://localhost/', {
    body: JSON.stringify({
      magic_invite_string: invitation.invite_magic_string,
      opt_for_newsletters: false,
      password: 'Password1!',
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  }))
}

describe('magic-link invitation acceptance telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    captureInvitationEventMock.mockResolvedValue(true)
    emptySupabaseMock.mockReturnValue({ auth: { signInWithPassword: signInMock } })
    signInMock.mockResolvedValue({
      data: {
        session: { access_token: 'access-token', refresh_token: 'refresh-token' },
        user: { id: FUTURE_USER_ID },
      },
      error: null,
    })
  })

  it('emits created only after a new account membership is finalized', async () => {
    supabaseAdminMock.mockReturnValue(buildAdmin({}))
    getPgClientMock.mockReturnValue(buildPgPool())
    createUserMock.mockResolvedValue({ data: { user: { id: FUTURE_USER_ID } }, error: null })

    const response = await acceptRequest()

    expect(response.status).toBe(200)
    expect(captureInvitationEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      accountState: 'created',
      event: 'organization_membership_invitation_accepted',
      flow: 'new_user_magic_link',
      invitationId: invitation.id,
      userId: FUTURE_USER_ID,
    }))
  })

  it('accepts for an already-existing account and emits already_existed', async () => {
    supabaseAdminMock.mockReturnValue(buildAdmin({ existingUserId: EXISTING_USER_ID }))
    getPgClientMock.mockReturnValue(buildPgPool())
    signInMock.mockResolvedValue({
      data: {
        session: { access_token: 'access-token', refresh_token: 'refresh-token' },
        user: { id: EXISTING_USER_ID },
      },
      error: null,
    })

    const response = await acceptRequest()

    expect(response.status).toBe(200)
    expect(createUserMock).not.toHaveBeenCalled()
    expect(captureInvitationEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      accountState: 'already_existed',
      event: 'organization_membership_invitation_accepted',
      userId: EXISTING_USER_ID,
    }))
  })

  it('accepts when tmp invite finalization is handled atomically in Postgres', async () => {
    supabaseAdminMock.mockReturnValue(buildAdmin({
      existingUserId: EXISTING_USER_ID,
    }))
    getPgClientMock.mockReturnValue(buildPgPool())
    signInMock.mockResolvedValue({
      data: {
        session: { access_token: 'access-token', refresh_token: 'refresh-token' },
        user: { id: EXISTING_USER_ID },
      },
      error: null,
    })

    const response = await acceptRequest()

    expect(response.status).toBe(200)
    expect(captureInvitationEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'organization_membership_invitation_accepted',
      invitationId: invitation.id,
      userId: EXISTING_USER_ID,
    }))
    expect(captureInvitationEventMock).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'organization_membership_invitation_failed',
    }))
  })

  it('keeps a newly created membership finalized when acceptance succeeds in Postgres', async () => {
    supabaseAdminMock.mockReturnValue(buildAdmin({}))
    getPgClientMock.mockReturnValue(buildPgPool())
    createUserMock.mockResolvedValue({ data: { user: { id: FUTURE_USER_ID } }, error: null })

    const response = await acceptRequest()

    expect(response.status).toBe(200)
    expect(deleteUserMock).not.toHaveBeenCalled()
    expect(captureInvitationEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      accountState: 'created',
      event: 'organization_membership_invitation_accepted',
      invitationId: invitation.id,
      userId: FUTURE_USER_ID,
    }))
    expect(captureInvitationEventMock).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'organization_membership_invitation_failed',
    }))
  })

  it('does not emit accepted again when the completed magic-link request is retried', async () => {
    const invitationAvailable = { value: true }
    supabaseAdminMock.mockReturnValue(buildAdmin({ existingUserId: EXISTING_USER_ID, invitationAvailable }))
    getPgClientMock.mockReturnValue(buildPgPool(['OK', 'NO_INVITE']))
    signInMock.mockResolvedValue({
      data: {
        session: { access_token: 'access-token', refresh_token: 'refresh-token' },
        user: { id: EXISTING_USER_ID },
      },
      error: null,
    })

    const first = await acceptRequest()
    const retry = await acceptRequest()

    expect(first.status).toBe(200)
    expect(retry.status).toBe(404)
    expect(captureInvitationEventMock.mock.calls.filter(([, event]) => event.event === 'organization_membership_invitation_accepted')).toHaveLength(1)
  })

  it('emits failed and never accepted when existing-account authentication fails', async () => {
    supabaseAdminMock.mockReturnValue(buildAdmin({ existingUserId: EXISTING_USER_ID }))
    getPgClientMock.mockReturnValue(buildPgPool())
    signInMock.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'Invalid credentials' } })

    const response = await acceptRequest()

    expect(response.status).toBe(400)
    expect(captureInvitationEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'organization_membership_invitation_failed',
      failureReason: 'acceptance_failed',
      userId: EXISTING_USER_ID,
    }))
    expect(captureInvitationEventMock).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'organization_membership_invitation_accepted',
    }))
  })
})
