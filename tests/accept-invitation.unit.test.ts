import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  captureInvitationEventMock,
  closeClientMock,
  cloudlogMock,
  createUserMock,
  deleteUserMock,
  emptySupabaseMock,
  getPgClientMock,
  signInMock,
  supabaseAdminMock,
} = vi.hoisted(() => ({
  captureInvitationEventMock: vi.fn(),
  closeClientMock: vi.fn(),
  cloudlogMock: vi.fn(),
  createUserMock: vi.fn(),
  deleteUserMock: vi.fn(),
  emptySupabaseMock: vi.fn(),
  getPgClientMock: vi.fn(),
  signInMock: vi.fn(),
  supabaseAdminMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: cloudlogMock,
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

function buildPgClient(options: {
  acceptError?: Error
  acceptStatuses?: string[]
  existingUserId?: string
} = {}) {
  const acceptStatuses = options.acceptStatuses ?? ['OK']
  let callCount = 0
  return {
    query: vi.fn(async (query: string) => {
      if (query.includes('accept_tmp_user_invitation')) {
        if (options.acceptError)
          throw options.acceptError
        const status = acceptStatuses[Math.min(callCount, acceptStatuses.length - 1)]
        callCount += 1
        return { rows: [{ accept_tmp_user_invitation: status }] }
      }
      if (query.includes('FROM public.tmp_users'))
        return { rows: [invitation] }
      if (query.includes('FROM public.orgs'))
        return { rows: [{ password_policy_config: null }] }
      if (query.includes('INSERT INTO public.users'))
        return { rows: [{ row: { id: FUTURE_USER_ID } }] }
      if (query.includes('FROM public.users WHERE email'))
        return { rows: options.existingUserId ? [{ id: options.existingUserId }] : [] }
      return { rows: [], rowCount: 0 }
    }),
  }
}

const adminClient = {
  auth: {
    admin: {
      createUser: createUserMock,
      deleteUser: deleteUserMock,
    },
  },
}

function acceptRequest(extraBody: Record<string, unknown> = {}) {
  return app.request(new Request('http://localhost/', {
    body: JSON.stringify({
      magic_invite_string: invitation.invite_magic_string,
      opt_for_newsletters: false,
      password: 'Password1!',
      ...extraBody,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  }))
}

function signInAsExistingUser() {
  signInMock.mockResolvedValue({
    data: {
      session: { access_token: 'access-token', refresh_token: 'refresh-token' },
      user: { id: EXISTING_USER_ID },
    },
    error: null,
  })
}

describe('accept invitation logging', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    supabaseAdminMock.mockReturnValue(adminClient)
    getPgClientMock.mockResolvedValue(buildPgClient())
    emptySupabaseMock.mockReturnValue({})
    createUserMock.mockResolvedValue({
      data: null,
      error: { message: 'stop after validated log' },
    })
  })

  it('redacts invitation bearer token from raw and validated body logs', async () => {
    const response = await acceptRequest({ captchaToken: 'captcha-secret' })

    expect(response.status).toBe(500)

    const rawBodyLog = cloudlogMock.mock.calls.find(([entry]) => entry.context === 'accept_invitation raw body')?.[0]
    const validatedBodyLog = cloudlogMock.mock.calls.find(([entry]) => entry.context === 'accept_invitation validated body')?.[0]

    expect(rawBodyLog?.rawBody).toEqual({ opt_for_newsletters: false })
    expect(validatedBodyLog?.body).toEqual({ opt_for_newsletters: false })
    const logs = JSON.stringify(cloudlogMock.mock.calls)
    expect(logs).not.toContain(invitation.invite_magic_string)
    expect(logs).not.toContain('Password1!')
    expect(logs).not.toContain('captcha-secret')
  })
})

describe('magic-link invitation acceptance telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    captureInvitationEventMock.mockResolvedValue(true)
    supabaseAdminMock.mockReturnValue(adminClient)
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
    getPgClientMock.mockResolvedValue(buildPgClient())
    createUserMock.mockResolvedValue({ data: { user: { id: FUTURE_USER_ID } }, error: null })

    const response = await acceptRequest()

    expect(response.status).toBe(200)
    expect(deleteUserMock).not.toHaveBeenCalled()
    expect(captureInvitationEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      accountState: 'created',
      event: 'organization_membership_invitation_accepted',
      flow: 'new_user_magic_link',
      invitationId: invitation.id,
      userId: FUTURE_USER_ID,
    }))
    expect(captureInvitationEventMock).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'organization_membership_invitation_failed',
    }))
  })

  it('accepts for an already-existing account and emits already_existed', async () => {
    getPgClientMock.mockResolvedValue(buildPgClient({ existingUserId: EXISTING_USER_ID }))
    signInAsExistingUser()

    const response = await acceptRequest()

    expect(response.status).toBe(200)
    expect(createUserMock).not.toHaveBeenCalled()
    expect(captureInvitationEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      accountState: 'already_existed',
      event: 'organization_membership_invitation_accepted',
      invitationId: invitation.id,
      userId: EXISTING_USER_ID,
    }))
    expect(captureInvitationEventMock).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'organization_membership_invitation_failed',
    }))
  })

  it('does not emit accepted again when the completed magic-link request is retried', async () => {
    getPgClientMock.mockResolvedValue(buildPgClient({ acceptStatuses: ['OK', 'NO_INVITE'], existingUserId: EXISTING_USER_ID }))
    signInAsExistingUser()

    const first = await acceptRequest()
    const retry = await acceptRequest()

    expect(first.status).toBe(200)
    expect(retry.status).toBe(404)
    expect(captureInvitationEventMock.mock.calls.filter(([, event]) => event.event === 'organization_membership_invitation_accepted')).toHaveLength(1)
  })

  it.each([
    ['INVITER_NOT_FOUND', 403, 'Invitation must be reissued before acceptance'],
    ['ALREADY_MEMBER', 409, 'already a member of this organization'],
    ['MEMBERSHIP_NOT_FINALIZED', 409, 'could not be finalized'],
    ['ROLE_NOT_FOUND', 500, 'Failed to resolve RBAC role'],
  ] as const)('maps accept_tmp_user_invitation status %s to HTTP %s', async (status, httpStatus, messageFragment) => {
    getPgClientMock.mockResolvedValue(buildPgClient({ acceptStatuses: [status], existingUserId: EXISTING_USER_ID }))
    signInAsExistingUser()

    const response = await acceptRequest()

    expect(response.status).toBe(httpStatus)
    const bodyText = await response.text()
    expect(bodyText).toContain(messageFragment)
  })

  it('maps privilege escalation errors to HTTP 403', async () => {
    getPgClientMock.mockResolvedValue(buildPgClient({
      acceptError: new Error('Admins cannot elevate privileges!'),
      existingUserId: EXISTING_USER_ID,
    }))
    signInAsExistingUser()

    const response = await acceptRequest()

    expect(response.status).toBe(403)
    expect(deleteUserMock).not.toHaveBeenCalled()
  })

  it('rolls back a newly created user when acceptance is rejected in Postgres', async () => {
    getPgClientMock.mockResolvedValue(buildPgClient({ acceptStatuses: ['INVITER_NOT_FOUND'] }))
    createUserMock.mockResolvedValue({ data: { user: { id: FUTURE_USER_ID } }, error: null })

    const response = await acceptRequest()

    expect(response.status).toBe(403)
    expect(deleteUserMock).toHaveBeenCalledWith(FUTURE_USER_ID)
  })

  it('emits failed and never accepted when existing-account authentication fails', async () => {
    getPgClientMock.mockResolvedValue(buildPgClient({ existingUserId: EXISTING_USER_ID }))
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
