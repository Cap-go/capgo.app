import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  captureInvitationEventMock,
  supabaseAdminMock,
  supabaseWithAuthMock,
} = vi.hoisted(() => ({
  captureInvitationEventMock: vi.fn(),
  supabaseAdminMock: vi.fn(),
  supabaseWithAuthMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/hono_jwt.ts', () => ({
  middlewareAuth: async (c: any, next: () => Promise<void>) => {
    c.set('auth', {
      apikey: null,
      authType: 'jwt',
      jwt: 'Bearer test-token',
      userId: '550e8400-e29b-41d4-a716-446655440000',
    })
    await next()
  },
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/organization_invitation_posthog.ts', () => ({
  captureOrganizationInvitationPosthogEvent: captureInvitationEventMock,
  sanitizeOrganizationInvitationFailureReason: (_error: unknown, fallback: string) => fallback,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: supabaseAdminMock,
  supabaseWithAuth: supabaseWithAuthMock,
}))

const { app } = await import('../supabase/functions/_backend/private/organization_invitation.ts')

const USER_ID = '550e8400-e29b-41d4-a716-446655440000'
const ORG_ID = 'a3d4cb0c-96df-4e65-bca4-b7e037a09017'

interface ClientOptions {
  acceptResults?: string[]
  deleteError?: Error | null
  deletedInvitationIds?: number[]
  pendingInvitationCount?: number
}

function buildAuthenticatedClient(options: ClientOptions = {}) {
  const acceptResults = [...(options.acceptResults ?? ['OK'])]
  const pendingInvitationCount = options.pendingInvitationCount ?? 2

  return {
    rpc: vi.fn(async (name: string) => {
      if (name === 'get_orgs_v7') {
        return {
          data: Array.from({ length: pendingInvitationCount }, () => ({ is_invite: true })),
          error: null,
        }
      }
      if (name === 'accept_invitation_to_org')
        return { data: acceptResults.shift() ?? 'NO_INVITE', error: null }
      throw new Error(`Unexpected RPC: ${name}`)
    }),
    from: vi.fn((table: string) => {
      expect(table).toBe('org_users')
      const selectChain: any = {
        eq: () => selectChain,
        maybeSingle: async () => ({ data: { id: 71 }, error: null }),
      }
      const deleteChain: any = {
        eq: () => deleteChain,
        in: () => deleteChain,
        select: async () => ({
          data: (options.deletedInvitationIds ?? [72]).map(id => ({ id })),
          error: options.deleteError ?? null,
        }),
      }
      return {
        delete: () => deleteChain,
        select: () => selectChain,
      }
    }),
  }
}

function postAuthenticatedAction(body: Record<string, unknown>) {
  return app.request(new Request('http://localhost/', {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  }))
}

describe('authenticated organization invitation endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    captureInvitationEventMock.mockResolvedValue(true)
  })

  it('emits accepted only after the pending membership RPC succeeds', async () => {
    supabaseWithAuthMock.mockReturnValue(buildAuthenticatedClient())

    const response = await postAuthenticatedAction({ action: 'accept', org_id: ORG_ID })

    expect(response.status).toBe(200)
    expect(captureInvitationEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      accountState: 'already_existed',
      event: 'organization_membership_invitation_accepted',
      flow: 'authenticated_pending_invite',
      invitationId: 71,
      pendingInvitationCount: 2,
      userId: USER_ID,
    }))
  })

  it('does not duplicate acceptance telemetry when a completed request is retried', async () => {
    supabaseWithAuthMock.mockReturnValue(buildAuthenticatedClient({ acceptResults: ['OK', 'NO_INVITE'] }))

    const first = await postAuthenticatedAction({ action: 'accept', org_id: ORG_ID })
    const retry = await postAuthenticatedAction({ action: 'accept', org_id: ORG_ID })

    expect(first.status).toBe(200)
    expect(retry.status).toBe(409)
    expect(captureInvitationEventMock.mock.calls.filter(([, event]) => event.event === 'organization_membership_invitation_accepted')).toHaveLength(1)
    expect(captureInvitationEventMock.mock.calls.filter(([, event]) => event.event === 'organization_membership_invitation_failed')).toHaveLength(1)
  })

  it('emits failed and never accepted when acceptance is rejected', async () => {
    supabaseWithAuthMock.mockReturnValue(buildAuthenticatedClient({ acceptResults: ['ROLE_NOT_FOUND'] }))

    const response = await postAuthenticatedAction({ action: 'accept', org_id: ORG_ID })

    expect(response.status).toBe(409)
    expect(captureInvitationEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'organization_membership_invitation_failed',
      failureReason: 'acceptance_failed',
      userId: USER_ID,
    }))
    expect(captureInvitationEventMock).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'organization_membership_invitation_accepted',
    }))
  })

  it('emits declined only for invitations actually deleted by the backend', async () => {
    supabaseWithAuthMock.mockReturnValue(buildAuthenticatedClient({ deletedInvitationIds: [72] }))

    const response = await postAuthenticatedAction({ action: 'decline', org_id: ORG_ID })

    expect(response.status).toBe(200)
    expect(captureInvitationEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'organization_membership_invitation_declined',
      flow: 'authenticated_pending_invite',
      invitationId: 72,
      userId: USER_ID,
    }))
  })

  it('emits viewed from the backend with the authenticated Capgo UUID', async () => {
    supabaseWithAuthMock.mockReturnValue(buildAuthenticatedClient({ pendingInvitationCount: 3 }))

    const response = await postAuthenticatedAction({ action: 'view' })

    expect(response.status).toBe(200)
    expect(captureInvitationEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'organization_membership_invitation_viewed',
      pendingInvitationCount: 3,
      userId: USER_ID,
    }))
  })
})

describe('magic-link invitation view endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    captureInvitationEventMock.mockResolvedValue(true)
  })

  it('resolves an already-existing account server-side without sending token or email to PostHog', async () => {
    const invitation = {
      cancelled_at: null,
      email: 'invitee@example.com',
      future_uuid: '1311385a-996f-4a0c-a758-75377255692a',
      id: 84,
    }
    const existingUser = { id: USER_ID }
    supabaseAdminMock.mockReturnValue({
      from: (table: string) => {
        const chain: any = {
          eq: () => chain,
          maybeSingle: async () => ({
            data: table === 'tmp_users' ? invitation : existingUser,
            error: null,
          }),
          select: () => chain,
        }
        return chain
      },
    })

    const response = await app.request(new Request('http://localhost/magic-view', {
      body: JSON.stringify({ magic_invite_string: 'secret-invitation-token' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    }))

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
})
