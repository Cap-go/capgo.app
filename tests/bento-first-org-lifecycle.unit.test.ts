import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  closeClientMock,
  createApiKeyMock,
  getPgClientMock,
  pgConnectMock,
  pgQueryMock,
  pgReleaseMock,
  sendEventToTrackingMock,
  syncBentoSubscriberTagsMock,
  syncUserPreferenceTagsMock,
  trackBentoEventMock,
  unsubscribeBentoMock,
} = vi.hoisted(() => {
  const pgQueryMock = vi.fn<(query: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>(async () => ({ rows: [] }))
  const pgReleaseMock = vi.fn<(destroy?: Error | boolean) => void>(() => undefined)
  const pgConnectMock = vi.fn(async () => ({ query: pgQueryMock, release: pgReleaseMock }))
  return {
    closeClientMock: vi.fn(async () => undefined),
    createApiKeyMock: vi.fn(async () => undefined),
    getPgClientMock: vi.fn(() => ({ connect: pgConnectMock, query: pgQueryMock })),
    pgConnectMock,
    pgQueryMock,
    pgReleaseMock,
    sendEventToTrackingMock: vi.fn(async () => undefined),
    syncBentoSubscriberTagsMock: vi.fn<(
      c: unknown,
      update: { deleteSegments: string[], email: string, segments: string[] }
        | Array<{ deleteSegments: string[], email: string, segments: string[] }>,
    ) => Promise<boolean | undefined>>(async () => true),
    syncUserPreferenceTagsMock: vi.fn(async () => undefined),
    trackBentoEventMock: vi.fn(async () => true as boolean | undefined),
    unsubscribeBentoMock: vi.fn(async () => true as boolean | undefined),
  }
})

vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({
  syncBentoSubscriberTags: syncBentoSubscriberTagsMock,
  trackBentoEvent: trackBentoEventMock,
  unsubscribeBento: unsubscribeBentoMock,
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
  getPgClient: getPgClientMock,
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
const SUPPRESSION_TAG = 'onboarding:first_org_recovery_suppressed'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const ROLE_BINDING_ID = '33333333-3333-4333-8333-333333333333'

type ExpectedLifecycleModule = typeof bentoFirstOrgLifecycle & {
  syncBentoFirstOrgOnEmailChange: (c: never, oldEmail: string, newEmail: string) => Promise<boolean | undefined>
  syncBentoFirstOrgOnRoleBindingWrite: (c: never, roleBindingId: string) => Promise<void>
}

async function suppressEmailAliases(oldEmail: string, newEmail: string) {
  return await (bentoFirstOrgLifecycle as ExpectedLifecycleModule)
    .syncBentoFirstOrgOnEmailChange({ get: vi.fn(() => 'request-id') } as never, oldEmail, newEmail)
}

async function syncRoleBinding(roleBindingId = ROLE_BINDING_ID) {
  return await (bentoFirstOrgLifecycle as ExpectedLifecycleModule)
    .syncBentoFirstOrgOnRoleBindingWrite({ get: vi.fn(() => 'request-id') } as never, roleBindingId)
}

function activeBinding(overrides: Record<string, unknown> = {}) {
  return {
    email: ' Current.User@Example.COM ',
    granted_at: new Date(JOINED_AT),
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

function firstOrgDatabaseState(hasActiveDirectOrgAccess = false, userIsRecoveryEligible = true) {
  return {
    has_active_direct_org_access: hasActiveDirectOrgAccess,
    user_is_recovery_eligible: userIsRecoveryEligible,
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
    pgConnectMock.mockImplementation(async () => ({ query: pgQueryMock, release: pgReleaseMock }))
    pgReleaseMock.mockImplementation(() => undefined)
    closeClientMock.mockResolvedValue(undefined)
    getPgClientMock.mockImplementation(() => ({ connect: pgConnectMock, query: pgQueryMock }))
    pgQueryMock.mockResolvedValue({ rows: [firstOrgDatabaseState()] })
    syncBentoSubscriberTagsMock.mockResolvedValue(true)
    trackBentoEventMock.mockResolvedValue(true)
    unsubscribeBentoMock.mockResolvedValue(true)
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
    expect(syncUserPreferenceTagsMock).toHaveBeenCalledWith(
      expect.anything(),
      'new.user@example.com',
      expect.objectContaining({ id: USER_ID }),
    )
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
    expect(pgQueryMock).toHaveBeenCalledTimes(3)
  })

  it('returns a retryable failure when default API-key provisioning times out on a lock', async () => {
    createApiKeyMock.mockRejectedValueOnce(Object.assign(new Error('lock timeout'), { code: '55P03' }))

    const response = await postUser()

    expect(response.status).toBe(500)
    expect(syncUserPreferenceTagsMock).not.toHaveBeenCalled()
    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
    expect(trackBentoEventMock).not.toHaveBeenCalled()
  })

  it('destroys each checked-out Workerd client before the following Bento request', async () => {
    const lifecycleTrace: string[] = []
    let queryNumber = 0
    pgQueryMock.mockImplementation(async () => {
      lifecycleTrace.push(`query:${++queryNumber}`)
      return { rows: [firstOrgDatabaseState()] }
    })
    // Workerd closeClient is intentionally a no-op. This test must prove the
    // checked-out clients are released without relying on pool shutdown.
    closeClientMock.mockImplementation(async () => undefined)
    pgReleaseMock.mockImplementation((destroy) => {
      lifecycleTrace.push(`client:released:${destroy}`)
    })
    syncBentoSubscriberTagsMock.mockImplementation(async () => {
      lifecycleTrace.push('tag:add')
      return true
    })
    trackBentoEventMock.mockImplementation(async () => {
      lifecycleTrace.push('event:entry')
      return true
    })

    const response = await postUser()

    expect(response.status).toBe(200)
    expect(lifecycleTrace).toEqual([
      'query:1',
      'client:released:true',
      'query:2',
      'client:released:true',
      'tag:add',
      'query:3',
      'client:released:true',
      'event:entry',
    ])
    expect(getPgClientMock).toHaveBeenCalledTimes(2)
    expect(pgConnectMock).toHaveBeenCalledTimes(3)
    expect(pgReleaseMock).toHaveBeenCalledTimes(3)
    expect(pgReleaseMock).toHaveBeenNthCalledWith(1, true)
    expect(pgReleaseMock).toHaveBeenNthCalledWith(2, true)
    expect(pgReleaseMock).toHaveBeenNthCalledWith(3, true)
    expect(closeClientMock).toHaveBeenCalledTimes(2)
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
    expect(pgQueryMock).toHaveBeenCalledTimes(2)
  })

  it('suppresses an invite-created profile when deletion is scheduled during provisioning', async () => {
    pgQueryMock
      .mockResolvedValueOnce({ rows: [firstOrgDatabaseState()] })
      .mockResolvedValueOnce({ rows: [firstOrgDatabaseState(false, false)] })

    const response = await postUser(userRecord({ created_via_invite: true }))

    expect(response.status).toBe(200)
    expect(createApiKeyMock).toHaveBeenCalledOnce()
    expect(syncUserPreferenceTagsMock).toHaveBeenCalledOnce()
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledOnce()
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(expect.anything(), [{
      deleteSegments: [LIFECYCLE_TAG],
      email: 'new.user@example.com',
      segments: [SUPPRESSION_TAG],
    }])
    expect(unsubscribeBentoMock).toHaveBeenCalledWith(expect.anything(), 'new.user@example.com')
    expect(trackBentoEventMock).not.toHaveBeenCalled()
  })

  it('permanently suppresses recovery when a delayed create message finds deletion scheduled', async () => {
    pgQueryMock.mockResolvedValue({ rows: [firstOrgDatabaseState(false, false)] })

    const response = await postUser()

    expect(response.status).toBe(200)
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(expect.anything(), [{
      deleteSegments: [LIFECYCLE_TAG],
      email: 'new.user@example.com',
      segments: [SUPPRESSION_TAG],
    }])
    expect(trackBentoEventMock).not.toHaveBeenCalled()
    expect(pgQueryMock).toHaveBeenCalledOnce()
    expect(createApiKeyMock).not.toHaveBeenCalled()
    expect(syncUserPreferenceTagsMock).not.toHaveBeenCalled()
    expect(unsubscribeBentoMock).toHaveBeenCalledWith(expect.anything(), 'new.user@example.com')
    expect(syncBentoSubscriberTagsMock.mock.invocationCallOrder[0])
      .toBeLessThan(unsubscribeBentoMock.mock.invocationCallOrder[0])
  })

  it('still attempts the final unsubscribe when deletion suppression throws', async () => {
    pgQueryMock.mockResolvedValue({ rows: [firstOrgDatabaseState(false, false)] })
    syncBentoSubscriberTagsMock.mockRejectedValueOnce(new Error('Bento unavailable'))

    const response = await postUser()

    expect(response.status).toBe(500)
    expect(unsubscribeBentoMock).toHaveBeenCalledWith(expect.anything(), 'new.user@example.com')
    expect(createApiKeyMock).not.toHaveBeenCalled()
    expect(syncUserPreferenceTagsMock).not.toHaveBeenCalled()
  })

  it('skips entry and removes a stale tag when active direct org access already exists', async () => {
    pgQueryMock.mockResolvedValue({ rows: [firstOrgDatabaseState(true)] })

    const response = await postUser()

    expect(response.status).toBe(200)
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(expect.anything(), {
      deleteSegments: [LIFECYCLE_TAG],
      email: 'new.user@example.com',
      segments: [],
    })
    expect(trackBentoEventMock).not.toHaveBeenCalled()
    expect(pgQueryMock).toHaveBeenCalledTimes(2)
  })

  it('suppresses an existing organization member when deletion is scheduled during provisioning', async () => {
    pgQueryMock
      .mockResolvedValueOnce({ rows: [firstOrgDatabaseState(true)] })
      .mockResolvedValueOnce({ rows: [firstOrgDatabaseState(false, false)] })

    const response = await postUser()

    expect(response.status).toBe(200)
    expect(createApiKeyMock).toHaveBeenCalledOnce()
    expect(syncUserPreferenceTagsMock).toHaveBeenCalledOnce()
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledOnce()
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(expect.anything(), [{
      deleteSegments: [LIFECYCLE_TAG],
      email: 'new.user@example.com',
      segments: [SUPPRESSION_TAG],
    }])
    expect(unsubscribeBentoMock).toHaveBeenCalledWith(expect.anything(), 'new.user@example.com')
    expect(trackBentoEventMock).not.toHaveBeenCalled()
  })

  it('restricts the active-access check to active direct user-to-org bindings', async () => {
    const response = await postUser()

    expect(response.status).toBe(200)
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(expect.anything(), {
      deleteSegments: [],
      email: 'new.user@example.com',
      segments: [LIFECYCLE_TAG],
    })
    expect(trackBentoEventMock).toHaveBeenCalledTimes(1)

    const normalizedQuery = String(pgQueryMock.mock.calls[0]?.[0]).replace(/\s+/g, ' ')
    expect(normalizedQuery).toContain('principal_type = \'user\'')
    expect(normalizedQuery).toContain('FROM public.users AS users')
    expect(normalizedQuery).toContain('FROM public.to_delete_accounts AS deleted')
    expect(normalizedQuery).toContain('scope_type = \'org\'')
    expect(normalizedQuery).toContain('is_direct IS TRUE')
    expect(normalizedQuery).toContain('org_id IS NOT NULL')
    expect(normalizedQuery).toContain('(expires_at IS NULL OR expires_at > pg_catalog.now())')
    expect(pgQueryMock.mock.calls[0]?.[1]).toEqual([USER_ID])
  })

  it('removes the tag and skips entry when org access appears after the tag write', async () => {
    const lifecycleTrace: string[] = []
    pgQueryMock
      .mockImplementationOnce(async () => {
        lifecycleTrace.push('query:preflight-no-access')
        return { rows: [firstOrgDatabaseState()] }
      })
      .mockImplementationOnce(async () => {
        lifecycleTrace.push('query:post-provision-no-access')
        return { rows: [firstOrgDatabaseState()] }
      })
      .mockImplementationOnce(async () => {
        lifecycleTrace.push('query:access-found')
        return { rows: [firstOrgDatabaseState(true)] }
      })
    syncBentoSubscriberTagsMock.mockImplementation(async (_c, update) => {
      await Promise.resolve()
      const updates = Array.isArray(update) ? update : [update]
      if (updates.some(item => item.segments.includes(LIFECYCLE_TAG)))
        lifecycleTrace.push('tag:add')
      if (updates.some(item => item.deleteSegments.includes(LIFECYCLE_TAG)))
        lifecycleTrace.push('tag:remove')
      return true
    })
    // Model Workerd: pool close does nothing, so only explicit client release
    // can appear before the external Bento operations.
    closeClientMock.mockImplementation(async () => undefined)
    pgReleaseMock.mockImplementation((destroy) => {
      lifecycleTrace.push(`client:released:${destroy}`)
    })

    const response = await postUser()

    expect(response.status).toBe(200)
    expect(lifecycleTrace).toEqual([
      'query:preflight-no-access',
      'client:released:true',
      'query:post-provision-no-access',
      'client:released:true',
      'tag:add',
      'query:access-found',
      'client:released:true',
      'tag:remove',
    ])
    expect(getPgClientMock).toHaveBeenCalledTimes(2)
    expect(pgConnectMock).toHaveBeenCalledTimes(3)
    expect(pgReleaseMock).toHaveBeenNthCalledWith(1, true)
    expect(pgReleaseMock).toHaveBeenNthCalledWith(2, true)
    expect(pgReleaseMock).toHaveBeenNthCalledWith(3, true)
    expect(closeClientMock).toHaveBeenCalledTimes(2)
    expect(pgQueryMock).toHaveBeenCalledTimes(3)
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledTimes(2)
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

  it('suppresses recovery when deletion is scheduled after the tag write', async () => {
    pgQueryMock
      .mockResolvedValueOnce({ rows: [firstOrgDatabaseState()] })
      .mockResolvedValueOnce({ rows: [firstOrgDatabaseState()] })
      .mockResolvedValueOnce({ rows: [firstOrgDatabaseState(false, false)] })

    const response = await postUser()

    expect(response.status).toBe(200)
    expect(syncBentoSubscriberTagsMock).toHaveBeenNthCalledWith(1, expect.anything(), {
      deleteSegments: [],
      email: 'new.user@example.com',
      segments: [LIFECYCLE_TAG],
    })
    expect(syncBentoSubscriberTagsMock).toHaveBeenNthCalledWith(2, expect.anything(), [{
      deleteSegments: [LIFECYCLE_TAG],
      email: 'new.user@example.com',
      segments: [SUPPRESSION_TAG],
    }])
    expect(trackBentoEventMock).not.toHaveBeenCalled()
    expect(createApiKeyMock).toHaveBeenCalledOnce()
    expect(syncUserPreferenceTagsMock).toHaveBeenCalledOnce()
    expect(unsubscribeBentoMock).toHaveBeenCalledWith(expect.anything(), 'new.user@example.com')
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

describe('first-organization recovery suppression on email changes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pgConnectMock.mockImplementation(async () => ({ query: pgQueryMock, release: pgReleaseMock }))
    pgReleaseMock.mockImplementation(() => undefined)
    closeClientMock.mockResolvedValue(undefined)
    getPgClientMock.mockImplementation(() => ({ connect: pgConnectMock, query: pgQueryMock }))
    pgQueryMock.mockResolvedValue({ rows: [firstOrgDatabaseState()] })
    syncBentoSubscriberTagsMock.mockResolvedValue(true)
    trackBentoEventMock.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('suppresses both unique normalized aliases and clears awaiting state in one batch', async () => {
    await expect(suppressEmailAliases(' Old.User@Example.COM ', ' New.User@Example.COM ')).resolves.toBe(true)

    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledOnce()
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(expect.anything(), [
      {
        deleteSegments: [LIFECYCLE_TAG],
        email: 'old.user@example.com',
        segments: [SUPPRESSION_TAG],
      },
      {
        deleteSegments: [LIFECYCLE_TAG],
        email: 'new.user@example.com',
        segments: [SUPPRESSION_TAG],
      },
    ])
  })

  it('deduplicates the same normalized alias within a batch', async () => {
    await expect(suppressEmailAliases(' Same.User@Example.COM ', 'same.user@example.com')).resolves.toBe(true)

    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(expect.anything(), [{
      deleteSegments: [LIFECYCLE_TAG],
      email: 'same.user@example.com',
      segments: [SUPPRESSION_TAG],
    }])
  })

  it('returns false for configured delivery failure and undefined when unconfigured', async () => {
    syncBentoSubscriberTagsMock.mockResolvedValueOnce(false)
    await expect(suppressEmailAliases('a@example.com', 'b@example.com')).resolves.toBe(false)

    syncBentoSubscriberTagsMock.mockResolvedValueOnce(undefined)
    await expect(suppressEmailAliases('a@example.com', 'b@example.com')).resolves.toBeUndefined()
  })

  it('keeps suppression monotonic across reversed, repeated, and chained alias changes', async () => {
    await suppressEmailAliases('A@Example.com', 'b@example.com')
    await suppressEmailAliases('b@example.com', 'A@example.com')
    await suppressEmailAliases('a@example.com', 'b@example.com')
    await suppressEmailAliases('b@example.com', 'c@example.com')
    await suppressEmailAliases('C@example.com', 'c@example.com')

    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledTimes(5)
    const expectedAliasBatches = [
      ['a@example.com', 'b@example.com'],
      ['b@example.com', 'a@example.com'],
      ['a@example.com', 'b@example.com'],
      ['b@example.com', 'c@example.com'],
      ['c@example.com'],
    ]
    const requestedAliases = new Set<string>()
    for (const [index, [, rawUpdate]] of syncBentoSubscriberTagsMock.mock.calls.entries()) {
      const updates = Array.isArray(rawUpdate) ? rawUpdate : [rawUpdate]
      expect(updates.map(update => update.email)).toEqual(expectedAliasBatches[index])
      expect(new Set(updates.map(update => update.email)).size).toBe(updates.length)
      for (const update of updates) {
        requestedAliases.add(update.email)
        expect(update.segments).toEqual([SUPPRESSION_TAG])
        expect(update.deleteSegments).toEqual([LIFECYCLE_TAG])
        expect(update.deleteSegments).not.toContain(SUPPRESSION_TAG)
      }
    }
    expect(requestedAliases).toEqual(new Set(['a@example.com', 'b@example.com', 'c@example.com']))
  })

  it('never removes permanent suppression when signup later adds awaiting state', async () => {
    await suppressEmailAliases('old@example.com', 'new@example.com')
    const response = await postUser(userRecord({ email: 'new@example.com' }))

    expect(response.status).toBe(200)
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledTimes(2)
    expect(syncBentoSubscriberTagsMock).toHaveBeenNthCalledWith(2, expect.anything(), {
      deleteSegments: [],
      email: 'new@example.com',
      segments: [LIFECYCLE_TAG],
    })
    for (const [, rawUpdate] of syncBentoSubscriberTagsMock.mock.calls) {
      const updates = Array.isArray(rawUpdate) ? rawUpdate : [rawUpdate]
      for (const update of updates)
        expect(update.deleteSegments).not.toContain(SUPPRESSION_TAG)
    }
  })
})

describe('first-organization lifecycle on direct org access', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pgConnectMock.mockImplementation(async () => ({ query: pgQueryMock, release: pgReleaseMock }))
    pgReleaseMock.mockImplementation(() => undefined)
    closeClientMock.mockResolvedValue(undefined)
    getPgClientMock.mockImplementation(() => ({ connect: pgConnectMock, query: pgQueryMock }))
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

  it('destroys the checked-out Workerd client before joined-org Bento requests', async () => {
    const lifecycleTrace: string[] = []
    pgQueryMock.mockImplementation(async () => {
      lifecycleTrace.push('binding:queried')
      return { rows: [activeBinding()] }
    })
    // Workerd closeClient is intentionally a no-op. The checked-out client
    // must be destroyed explicitly before any external Bento request starts.
    closeClientMock.mockImplementation(async () => undefined)
    pgReleaseMock.mockImplementation((destroy) => {
      lifecycleTrace.push(`client:released:${destroy}`)
    })
    syncBentoSubscriberTagsMock.mockImplementation(async () => {
      lifecycleTrace.push('tag:remove')
      return true
    })
    trackBentoEventMock.mockImplementation(async () => {
      lifecycleTrace.push('event:joined')
      return true
    })

    await syncRoleBinding()

    expect(lifecycleTrace).toEqual([
      'binding:queried',
      'client:released:true',
      'tag:remove',
      'event:joined',
    ])
    expect(getPgClientMock).toHaveBeenCalledOnce()
    expect(pgConnectMock).toHaveBeenCalledOnce()
    expect(pgReleaseMock).toHaveBeenCalledOnce()
    expect(pgReleaseMock).toHaveBeenCalledWith(true)
    expect(closeClientMock).toHaveBeenCalledOnce()
    expect(closeClientMock).toHaveBeenCalledWith(expect.anything(), getPgClientMock.mock.results[0]?.value)
    expect(trackBentoEventMock.mock.invocationCallOrder[0])
      .toBeLessThan(closeClientMock.mock.invocationCallOrder[0]!)
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
    expect(syncBentoSubscriberTagsMock).toHaveBeenNthCalledWith(1, expect.anything(), {
      deleteSegments: [LIFECYCLE_TAG],
      email: 'current.user@example.com',
      segments: [],
    })
    expect(syncBentoSubscriberTagsMock).toHaveBeenNthCalledWith(2, expect.anything(), {
      deleteSegments: [LIFECYCLE_TAG],
      email: 'current.user@example.com',
      segments: [],
    })
    expect(trackBentoEventMock).toHaveBeenCalledTimes(2)
    const factData = {
      joined_at: JOINED_AT,
      org_id: ORG_ID,
      role_binding_id: ROLE_BINDING_ID,
      user_id: USER_ID,
    }
    expect(trackBentoEventMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'current.user@example.com',
      factData,
      'user:joined_org',
    )
    expect(trackBentoEventMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'current.user@example.com',
      factData,
      'user:joined_org',
    )
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
