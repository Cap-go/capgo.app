import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  captureInvitationEventMock,
  cloudlogErrMock,
  createSignedImageUrlMock,
  getPgClientMock,
} = vi.hoisted(() => ({
  captureInvitationEventMock: vi.fn(),
  cloudlogErrMock: vi.fn(),
  createSignedImageUrlMock: vi.fn(),
  getPgClientMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: cloudlogErrMock,
}))

vi.mock('../supabase/functions/_backend/utils/organization_invitation_posthog.ts', () => ({
  captureOrganizationInvitationPosthogEvent: captureInvitationEventMock,
}))

vi.mock('../supabase/functions/_backend/utils/storage.ts', () => ({
  createSignedImageUrl: createSignedImageUrlMock,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: vi.fn(),
  getPgClient: getPgClientMock,
}))

const { app } = await import('../supabase/functions/_backend/private/organization_invitation.ts')

const USER_ID = '550e8400-e29b-41d4-a716-446655440000'
const FUTURE_USER_ID = '1311385a-996f-4a0c-a758-75377255692a'
const ORG_ID = 'f8c34640-4478-46c8-87f5-bcc7548d1355'
const OTHER_ORG_ID = '2a46c8fd-e122-43ef-8ac6-743f4d2d1dc2'
const ORG_OWNER_ID = 'b9f76c28-2d51-43e2-81da-19d648dd49b9'
const SIGNED_LOGO_URL = 'https://example.supabase.co/storage/v1/object/sign/images/org-logo.png?token=signed'
const INVITATION_DATA = {
  org_logo: `org/${ORG_ID}/logo/organization-logo.png`,
  org_name: 'Example organization',
  role: 'org_member',
}
const SIGNED_INVITATION_DATA = {
  ...INVITATION_DATA,
  org_logo: SIGNED_LOGO_URL,
}

interface ClientOptions {
  existingUser?: { id: string } | null
  identityError?: Error | null
  invitationData?: typeof INVITATION_DATA | null
  organizationError?: Error | null
  organizationOwner?: { created_by: string } | null
}

function buildPgClient(options: ClientOptions = {}) {
  const invitationIdentity = {
    email: 'invitee@example.com',
    future_uuid: FUTURE_USER_ID,
    org_id: ORG_ID,
  }

  return {
    query: vi.fn(async (text: string) => {
      if (text.includes('public.get_invite_by_magic_lookup')) {
        const invitationData = options.invitationData === undefined ? INVITATION_DATA : options.invitationData
        return { rows: invitationData ? [{ row: invitationData }] : [] }
      }
      if (text.includes('FROM public.tmp_users')) {
        if (options.identityError)
          throw options.identityError
        return { rows: [invitationIdentity] }
      }
      if (text.includes('FROM public.orgs')) {
        if (options.organizationError)
          throw options.organizationError
        const owner = options.organizationOwner === undefined ? { created_by: ORG_OWNER_ID } : options.organizationOwner
        return { rows: owner ? [owner] : [] }
      }
      if (text.includes('FROM public.users')) {
        const existingUser = options.existingUser === undefined ? { id: USER_ID } : options.existingUser
        return { rows: existingUser ? [existingUser] : [] }
      }
      throw new Error(`Unexpected query: ${text}`)
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
    createSignedImageUrlMock.mockImplementation(async (_context, rawLogo: string, scope?: { orgId?: string, userId?: string }) => {
      if (rawLogo.startsWith('https://'))
        return rawLogo
      const belongsToOrganization = scope?.orgId && rawLogo.startsWith(`org/${scope.orgId}/logo/`)
      const belongsToUser = scope?.userId && rawLogo.startsWith(`${scope.userId}/`)
      return belongsToOrganization || belongsToUser ? SIGNED_LOGO_URL : null
    })
  })

  it('returns a signed organization logo and tracks a new account with its future Capgo UUID', async () => {
    getPgClientMock.mockResolvedValue(buildPgClient({ existingUser: null }))

    const response = await postMagicLookup()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(SIGNED_INVITATION_DATA)
    expect(createSignedImageUrlMock).toHaveBeenCalledWith(
      expect.anything(),
      INVITATION_DATA.org_logo,
      { orgId: ORG_ID, userId: ORG_OWNER_ID },
    )
    expect(captureInvitationEventMock).toHaveBeenCalledWith(expect.anything(), {
      event: 'organization_membership_invitation_viewed',
      flow: 'new_user_magic_link',
      pendingInvitationCount: 1,
      userId: FUTURE_USER_ID,
    })
  })

  it('tracks an already-existing account using its actual Capgo UUID without exposing PII', async () => {
    getPgClientMock.mockResolvedValue(buildPgClient({ existingUser: { id: USER_ID } }))

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

  it('uses the organization owner scope for legacy logo storage paths', async () => {
    const legacyLogoPath = `${ORG_OWNER_ID}/organization-logo.png`
    getPgClientMock.mockResolvedValue(buildPgClient({
      invitationData: {
        ...INVITATION_DATA,
        org_logo: legacyLogoPath,
      },
    }))

    const response = await postMagicLookup()

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ org_logo: SIGNED_LOGO_URL })
    expect(createSignedImageUrlMock).toHaveBeenCalledWith(
      expect.anything(),
      legacyLogoPath,
      { orgId: ORG_ID, userId: ORG_OWNER_ID },
    )
  })

  it('does not sign a logo storage key belonging to another organization', async () => {
    const outOfScopeLogoPath = `org/${OTHER_ORG_ID}/logo/organization-logo.png`
    getPgClientMock.mockResolvedValue(buildPgClient({
      invitationData: {
        ...INVITATION_DATA,
        org_logo: outOfScopeLogoPath,
      },
    }))

    const response = await postMagicLookup()

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ org_logo: '' })
    expect(createSignedImageUrlMock).toHaveBeenCalledWith(
      expect.anything(),
      outOfScopeLogoPath,
      { orgId: ORG_ID, userId: ORG_OWNER_ID },
    )
  })

  it.each([
    ['external', 'https://cdn.example.com/organization-logo.png'],
    ['Supabase storage', 'https://example.supabase.co/storage/v1/object/public/images/organization-logo.png'],
  ])('keeps %s organization logo URLs unchanged', async (_label, logoUrl) => {
    getPgClientMock.mockResolvedValue(buildPgClient({
      invitationData: {
        ...INVITATION_DATA,
        org_logo: logoUrl,
      },
    }))

    const response = await postMagicLookup()

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ org_logo: logoUrl })
    expect(createSignedImageUrlMock).not.toHaveBeenCalled()
  })

  it('does not emit viewed for an invalid or expired invitation', async () => {
    getPgClientMock.mockResolvedValue(buildPgClient({ invitationData: null }))

    const response = await postMagicLookup('invalid-token')

    expect(response.status).toBe(404)
    expect(captureInvitationEventMock).not.toHaveBeenCalled()
  })

  it('still returns invitation details when telemetry identity lookup fails', async () => {
    getPgClientMock.mockResolvedValue(buildPgClient({ identityError: new Error('database unavailable') }))

    const response = await postMagicLookup()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ...INVITATION_DATA,
      org_logo: '',
    })
    expect(captureInvitationEventMock).not.toHaveBeenCalled()
    expect(cloudlogErrMock).toHaveBeenCalled()
  })

  it('falls back to initials instead of returning a raw logo key when signing fails', async () => {
    getPgClientMock.mockResolvedValue(buildPgClient())
    createSignedImageUrlMock.mockResolvedValueOnce(null)

    const response = await postMagicLookup()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ...INVITATION_DATA,
      org_logo: '',
    })
  })

  it('still returns invitation details when PostHog capture fails', async () => {
    getPgClientMock.mockResolvedValue(buildPgClient())
    captureInvitationEventMock.mockRejectedValue(new Error('PostHog unavailable'))

    const response = await postMagicLookup()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(SIGNED_INVITATION_DATA)
  })
})
