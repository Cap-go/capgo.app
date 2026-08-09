import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  closeClientMock,
  getPgClientMock,
  pgConnectMock,
  pgQueryMock,
  pgReleaseMock,
  syncBentoSubscriberTagsMock,
} = vi.hoisted(() => {
  const pgQueryMock = vi.fn<(query: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>(async () => ({ rows: [] }))
  const pgReleaseMock = vi.fn<(destroy?: Error | boolean) => void>(() => undefined)
  const pgConnectMock = vi.fn(async () => ({ query: pgQueryMock, release: pgReleaseMock }))
  return {
    closeClientMock: vi.fn(async () => undefined),
    getPgClientMock: vi.fn(() => ({ connect: pgConnectMock, query: pgQueryMock })),
    pgConnectMock,
    pgQueryMock,
    pgReleaseMock,
    syncBentoSubscriberTagsMock: vi.fn<(
      c: unknown,
      update: { deleteSegments: string[], email: string, segments: string[] },
    ) => Promise<boolean | undefined>>(async () => true),
  }
})

vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({
  syncBentoSubscriberTags: syncBentoSubscriberTagsMock,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: closeClientMock,
  getPgClient: getPgClientMock,
}))

const {
  BENTO_ORG_INVITE_ACCEPTED_TAG,
  syncBentoOrgInviteAcceptedOnRoleBindingWrite,
} = await import('../supabase/functions/_backend/utils/bento_org_invite.ts')

const ROLE_BINDING_ID = '33333333-3333-4333-8333-333333333333'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '11111111-1111-4111-8111-111111111111'

function acceptedBinding(overrides: Record<string, unknown> = {}) {
  return {
    email: ' Invitee@Example.COM ',
    id: ROLE_BINDING_ID,
    is_active: true,
    is_direct: true,
    org_id: ORG_ID,
    principal_id: USER_ID,
    principal_type: 'user',
    reason: 'Accepted invitation',
    scope_type: 'org',
    ...overrides,
  }
}

async function syncInviteAccepted(roleBindingId = ROLE_BINDING_ID) {
  return await syncBentoOrgInviteAcceptedOnRoleBindingWrite(
    { get: vi.fn(() => 'request-id') } as never,
    roleBindingId,
  )
}

describe('bento org invite accepted tag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    syncBentoSubscriberTagsMock.mockResolvedValue(true)
    pgQueryMock.mockResolvedValue({ rows: [acceptedBinding()] })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('tags the invitee email when the binding reason is Accepted invitation', async () => {
    await syncInviteAccepted()

    expect(pgQueryMock).toHaveBeenCalledOnce()
    expect(pgQueryMock.mock.calls[0]?.[1]).toEqual([ROLE_BINDING_ID])
    expect(pgReleaseMock).toHaveBeenCalledWith(true)
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledOnce()
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(expect.anything(), {
      deleteSegments: [],
      email: 'invitee@example.com',
      segments: [BENTO_ORG_INVITE_ACCEPTED_TAG],
    })
    expect(closeClientMock).toHaveBeenCalledOnce()
  })

  it.each([
    ['wrong reason', { reason: 'SSO org membership provisioning' }],
    ['inactive binding', { is_active: false }],
    ['non-direct binding', { is_direct: false }],
    ['non-org scope', { scope_type: 'app' }],
    ['non-user principal', { principal_type: 'apikey' }],
    ['missing email', { email: null }],
    ['missing org', { org_id: null }],
  ])('skips Bento when %s', async (_label, overrides) => {
    pgQueryMock.mockResolvedValue({ rows: [acceptedBinding(overrides)] })

    await syncInviteAccepted()

    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
    expect(closeClientMock).toHaveBeenCalledOnce()
  })

  it('skips Bento when the role binding row is missing', async () => {
    pgQueryMock.mockResolvedValue({ rows: [] })

    await syncInviteAccepted()

    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
    expect(closeClientMock).toHaveBeenCalledOnce()
  })

  it('swallows Bento sync failures without throwing', async () => {
    syncBentoSubscriberTagsMock.mockResolvedValue(false)

    await expect(syncInviteAccepted()).resolves.toBeUndefined()
    expect(closeClientMock).toHaveBeenCalledOnce()
  })
})
