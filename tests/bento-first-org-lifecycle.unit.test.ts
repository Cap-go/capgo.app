import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  closeClientMock,
  createApiKeyMock,
  pgQueryMock,
  sendEventToTrackingMock,
  syncBentoSubscriberTagsMock,
  syncUserPreferenceTagsMock,
  trackBentoEventMock,
} = vi.hoisted(() => ({
  closeClientMock: vi.fn(async () => undefined),
  createApiKeyMock: vi.fn(async () => undefined),
  pgQueryMock: vi.fn<(query: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>(async () => ({ rows: [] })),
  sendEventToTrackingMock: vi.fn(async () => undefined),
  syncBentoSubscriberTagsMock: vi.fn(async () => true as boolean | undefined),
  syncUserPreferenceTagsMock: vi.fn(async () => undefined),
  trackBentoEventMock: vi.fn(async () => true as boolean | undefined),
}))

vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({
  syncBentoSubscriberTags: syncBentoSubscriberTagsMock,
  trackBentoEvent: trackBentoEventMock,
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/hono.ts')
  return {
    ...actual,
    middlewareAPISecret: async (_c: unknown, next: () => Promise<void>) => await next(),
  }
})

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: closeClientMock,
  getPgClient: vi.fn(() => ({ query: pgQueryMock })),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  createApiKey: createApiKeyMock,
}))

vi.mock('../supabase/functions/_backend/utils/tracking.ts', () => ({
  sendEventToTracking: sendEventToTrackingMock,
}))

vi.mock('../supabase/functions/_backend/utils/user_preferences.ts', () => ({
  syncUserPreferenceTags: syncUserPreferenceTagsMock,
}))

const { app: onUserCreateApp } = await import('../supabase/functions/_backend/triggers/on_user_create.ts')
const bentoFirstOrgLifecycle = await import('../supabase/functions/_backend/utils/bento_first_org.ts')

const USER_ID = '11111111-1111-4111-8111-111111111111'
const REGISTERED_AT = '2026-08-03T08:30:00.000Z'
const JOINED_AT = '2026-08-03T09:15:00.000Z'
const LIFECYCLE_TAG = 'onboarding:awaiting_first_org'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const ROLE_BINDING_ID = '33333333-3333-4333-8333-333333333333'

type ExpectedLifecycleModule = typeof bentoFirstOrgLifecycle & {
  syncBentoFirstOrgOnRoleBindingWrite: (c: never, roleBindingId: string) => Promise<void>
}

async function syncRoleBinding(roleBindingId = ROLE_BINDING_ID) {
  return await (bentoFirstOrgLifecycle as ExpectedLifecycleModule)
    .syncBentoFirstOrgOnRoleBindingWrite({ get: vi.fn(() => 'request-id') } as never, roleBindingId)
}

function activeBinding(overrides: Record<string, unknown> = {}) {
  return {
    email: ' Current.User@Example.COM ',
    granted_at: JOINED_AT,
    id: ROLE_BINDING_ID,
    is_active: true,
    is_direct: true,
    org_id: ORG_ID,
    principal_id: USER_ID,
    principal_type: 'user',
    scope_type: 'org',
    ...overrides,
  }
}

function userRecord(overrides: Record<string, unknown> = {}) {
  return {
    ban_time: null,
    country: null,
    created_at: REGISTERED_AT,
    created_via_invite: false,
    discord_username: null,
    email: ' New.User@Example.COM ',
    email_preferences: {},
    enable_notifications: false,
    first_name: 'New',
    format_locale: null,
    github_id: null,
    github_username: null,
    id: USER_ID,
    image_url: null,
    last_name: 'User',
    opt_for_newsletters: false,
    updated_at: REGISTERED_AT,
    ...overrides,
  }
}

async function postUser(record = userRecord()) {
  return await onUserCreateApp.request('http://local/', {
    body: JSON.stringify({
      old_record: null,
      record,
      schema: 'public',
      table: 'users',
      type: 'INSERT',
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
}

describe('first-organization lifecycle on user registration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pgQueryMock.mockResolvedValue({ rows: [] })
    syncBentoSubscriberTagsMock.mockResolvedValue(true)
    trackBentoEventMock.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('adds the lifecycle tag and emits the entry event when no active org access exists', async () => {
    const response = await postUser()

    expect(response.status).toBe(200)
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(expect.anything(), {
      deleteSegments: [],
      email: 'new.user@example.com',
      segments: [LIFECYCLE_TAG],
    })
    expect(trackBentoEventMock).toHaveBeenCalledWith(
      expect.anything(),
      'new.user@example.com',
      {
        created_via_invite: false,
        registered_at: REGISTERED_AT,
        user_id: USER_ID,
      },
      'user:registered_without_org',
    )
    expect(pgQueryMock).toHaveBeenCalledTimes(2)
  })

  it('skips entry and removes a stale lifecycle tag for invite-created profiles', async () => {
    const response = await postUser(userRecord({ created_via_invite: true }))

    expect(response.status).toBe(200)
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(expect.anything(), {
      deleteSegments: [LIFECYCLE_TAG],
      email: 'new.user@example.com',
      segments: [],
    })
    expect(trackBentoEventMock).not.toHaveBeenCalled()
    expect(pgQueryMock).not.toHaveBeenCalled()
  })

  it('skips entry and removes a stale tag when active direct org access already exists', async () => {
    pgQueryMock.mockResolvedValue({ rows: [{ id: 'binding-1' }] })

    const response = await postUser()

    expect(response.status).toBe(200)
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(expect.anything(), {
      deleteSegments: [LIFECYCLE_TAG],
      email: 'new.user@example.com',
      segments: [],
    })
    expect(trackBentoEventMock).not.toHaveBeenCalled()
    expect(pgQueryMock).toHaveBeenCalledTimes(1)
  })

  it('does not count an expired pending invitation as active access', async () => {
    const response = await postUser()

    expect(response.status).toBe(200)
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(expect.anything(), {
      deleteSegments: [],
      email: 'new.user@example.com',
      segments: [LIFECYCLE_TAG],
    })
    expect(trackBentoEventMock).toHaveBeenCalledTimes(1)

    const normalizedQuery = String(pgQueryMock.mock.calls[0]?.[0]).replace(/\s+/g, ' ')
    expect(normalizedQuery).toContain("principal_type = 'user'")
    expect(normalizedQuery).toContain("scope_type = 'org'")
    expect(normalizedQuery).toContain('is_direct IS TRUE')
    expect(normalizedQuery).toContain('org_id IS NOT NULL')
    expect(normalizedQuery).toContain('(expires_at IS NULL OR expires_at > pg_catalog.now())')
    expect(pgQueryMock.mock.calls[0]?.[1]).toEqual([USER_ID])
  })

  it('removes the tag and skips entry when org access appears after the tag write', async () => {
    pgQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'binding-after-tag' }] })

    const response = await postUser()

    expect(response.status).toBe(200)
    expect(syncBentoSubscriberTagsMock).toHaveBeenNthCalledWith(1, expect.anything(), {
      deleteSegments: [],
      email: 'new.user@example.com',
      segments: [LIFECYCLE_TAG],
    })
    expect(syncBentoSubscriberTagsMock).toHaveBeenNthCalledWith(2, expect.anything(), {
      deleteSegments: [LIFECYCLE_TAG],
      email: 'new.user@example.com',
      segments: [],
    })
    expect(trackBentoEventMock).not.toHaveBeenCalled()
  })

  it.each([
    ['returns false', async () => false],
    ['throws', async () => { throw new Error('Bento unavailable') }],
  ])('fails the handler for retry when configured Bento %s', async (_label, failure) => {
    syncBentoSubscriberTagsMock.mockImplementationOnce(failure)

    const response = await postUser()

    expect(response.status).toBe(500)
    expect(trackBentoEventMock).not.toHaveBeenCalled()
  })

  it('fails the handler for retry when the entry event returns false', async () => {
    trackBentoEventMock.mockResolvedValue(false)

    const response = await postUser()

    expect(response.status).toBe(500)
  })

  it('succeeds as a no-op when Bento is not configured', async () => {
    syncBentoSubscriberTagsMock.mockResolvedValue(undefined)
    trackBentoEventMock.mockResolvedValue(undefined)

    const response = await postUser()

    expect(response.status).toBe(200)
    expect(trackBentoEventMock).toHaveBeenCalledTimes(1)
  })
})

describe('first-organization lifecycle on direct org access', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pgQueryMock.mockResolvedValue({ rows: [activeBinding()] })
    syncBentoSubscriberTagsMock.mockResolvedValue(true)
    trackBentoEventMock.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('removes the lifecycle tag and emits a joined-org fact for a qualifying binding', async () => {
    await syncRoleBinding()

    expect(pgQueryMock).toHaveBeenCalledWith(expect.stringContaining('FROM public.role_bindings'), [ROLE_BINDING_ID])
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(expect.anything(), {
      deleteSegments: [LIFECYCLE_TAG],
      email: 'current.user@example.com',
      segments: [],
    })
    expect(trackBentoEventMock).toHaveBeenCalledWith(
      expect.anything(),
      'current.user@example.com',
      {
        joined_at: JOINED_AT,
        org_id: ORG_ID,
        role_binding_id: ROLE_BINDING_ID,
        user_id: USER_ID,
      },
      'user:joined_org',
    )
  })

  it.each([
    ['deleted binding', null],
    ['expired binding', activeBinding({ is_active: false })],
    ['API-key binding', activeBinding({ principal_type: 'apikey' })],
    ['non-org binding', activeBinding({ scope_type: 'app' })],
    ['null-org binding', activeBinding({ org_id: null })],
    ['inherited binding', activeBinding({ is_direct: false })],
    ['binding without a current user email', activeBinding({ email: null })],
  ])('is a no-op for a %s', async (_label, binding) => {
    pgQueryMock.mockResolvedValue({ rows: binding ? [binding] : [] })

    await syncRoleBinding()

    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
    expect(trackBentoEventMock).not.toHaveBeenCalled()
  })

  it('repeats the fact event while keeping tag removal idempotent for duplicate messages', async () => {
    await syncRoleBinding()
    await syncRoleBinding()

    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledTimes(2)
    expect(trackBentoEventMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['tag delivery returns false', () => syncBentoSubscriberTagsMock.mockResolvedValueOnce(false)],
    ['tag delivery throws', () => syncBentoSubscriberTagsMock.mockRejectedValueOnce(new Error('Bento unavailable'))],
    ['fact event returns false', () => trackBentoEventMock.mockResolvedValueOnce(false)],
  ])('fails for retry when configured Bento %s', async (_label, configureFailure) => {
    configureFailure()

    await expect(syncRoleBinding()).rejects.toThrow()
  })

  it('succeeds as a no-op when Bento is not configured', async () => {
    syncBentoSubscriberTagsMock.mockResolvedValue(undefined)
    trackBentoEventMock.mockResolvedValue(undefined)

    await expect(syncRoleBinding()).resolves.toBeUndefined()
  })
})
