import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  cancelSubscriptionMock,
  supabaseAdminMock,
  syncBentoSubscriberTagsMock,
  unsubscribeBentoMock,
} = vi.hoisted(() => ({
  cancelSubscriptionMock: vi.fn(async () => undefined as boolean | undefined),
  supabaseAdminMock: vi.fn(),
  syncBentoSubscriberTagsMock: vi.fn(async () => true as boolean | undefined),
  unsubscribeBentoMock: vi.fn(async () => true as boolean | undefined),
}))

vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({
  syncBentoSubscriberTags: syncBentoSubscriberTagsMock,
  trackBentoEvent: vi.fn(),
  unsubscribeBento: unsubscribeBentoMock,
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/hono.ts')
  return {
    ...actual,
    middlewareAPISecret: async (_c: unknown, next: () => Promise<void>) => await next(),
  }
})

vi.mock('../supabase/functions/_backend/utils/stripe.ts', () => ({
  cancelSubscription: cancelSubscriptionMock,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: supabaseAdminMock,
}))

const { app } = await import('../supabase/functions/_backend/triggers/on_user_delete.ts')

const USER_ID = '11111111-1111-4111-8111-111111111111'

function queryBuilder(data: unknown[] = [], error: unknown = null) {
  const result = Promise.resolve({ data, error })
  const builder = {
    eq: vi.fn(),
    in: vi.fn(),
    select: vi.fn(),
    then: result.then.bind(result),
  }
  builder.eq.mockReturnValue(builder)
  builder.in.mockReturnValue(builder)
  builder.select.mockReturnValue(builder)
  return builder
}

function configureSingleOrgCleanup() {
  const orgId = '22222222-2222-4222-8222-222222222222'
  const roleBindingResults = [
    [{ expires_at: null, org_id: orgId }],
    [{ expires_at: null, org_id: orgId, principal_id: USER_ID }],
    [],
  ]
  let roleBindingRead = 0
  const client = {
    from: vi.fn((table: string) => {
      if (table === 'role_bindings')
        return queryBuilder(roleBindingResults[roleBindingRead++] ?? [])
      if (table === 'orgs')
        return queryBuilder([{ customer_id: 'cus_deleted_user', id: orgId, management_email: null }])
      return queryBuilder()
    }),
    storage: {
      from: vi.fn(() => ({
        list: vi.fn(async () => ({ data: [] })),
      })),
    },
  }
  supabaseAdminMock.mockReturnValue(client)
}

function deletedUserRecord() {
  return {
    ban_time: null,
    country: null,
    created_at: '2026-08-03T08:30:00.000Z',
    created_via_invite: false,
    discord_username: null,
    email: ' Deleted.User@Example.COM ',
    email_preferences: {},
    enable_notifications: false,
    first_name: 'Deleted',
    format_locale: null,
    github_id: null,
    github_username: null,
    id: USER_ID,
    image_url: null,
    last_name: 'User',
    opt_for_newsletters: false,
    updated_at: '2026-08-03T09:00:00.000Z',
  }
}

function postDelete() {
  return app.request('http://local/', {
    body: JSON.stringify({
      old_record: deletedUserRecord(),
      record: null,
      schema: 'public',
      table: 'users',
      type: 'DELETE',
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
}

describe('user deletion Bento recovery safety', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cancelSubscriptionMock.mockResolvedValue(undefined)
    syncBentoSubscriberTagsMock.mockResolvedValue(true)
    unsubscribeBentoMock.mockResolvedValue(true)
    const emptyBuilder = queryBuilder()
    supabaseAdminMock.mockReturnValue({
      from: vi.fn(() => emptyBuilder),
    })
  })

  it('suppresses and unsubscribes a no-org user before organization cleanup returns', async () => {
    const response = await postDelete()

    expect(response.status).toBe(200)
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(expect.anything(), [{
      deleteSegments: ['onboarding:awaiting_first_org'],
      email: 'deleted.user@example.com',
      segments: ['onboarding:first_org_recovery_suppressed'],
    }])
    expect(unsubscribeBentoMock).toHaveBeenCalledWith(expect.anything(), 'deleted.user@example.com')
    expect(syncBentoSubscriberTagsMock.mock.invocationCallOrder[0])
      .toBeLessThan(unsubscribeBentoMock.mock.invocationCallOrder[0])
    expect(cancelSubscriptionMock).not.toHaveBeenCalled()
  })

  it.each([
    ['suppression', () => syncBentoSubscriberTagsMock.mockResolvedValue(false)],
    ['suppression exception', () => syncBentoSubscriberTagsMock.mockRejectedValue(new Error('Bento unavailable'))],
    ['unsubscribe', () => unsubscribeBentoMock.mockResolvedValue(false)],
    ['unsubscribe exception', () => unsubscribeBentoMock.mockRejectedValue(new Error('Bento unavailable'))],
  ])('fails for queue retry when Bento %s cleanup fails', async (_label, fail) => {
    fail()

    const response = await postDelete()

    expect(response.status).toBe(500)
    expect(unsubscribeBentoMock).toHaveBeenCalledOnce()
    expect(syncBentoSubscriberTagsMock.mock.invocationCallOrder[0])
      .toBeLessThan(unsubscribeBentoMock.mock.invocationCallOrder[0])
    expect(supabaseAdminMock).toHaveBeenCalled()
  })

  it('completes subscription cleanup before returning a retryable Bento failure', async () => {
    syncBentoSubscriberTagsMock.mockResolvedValue(false)
    configureSingleOrgCleanup()

    const response = await postDelete()

    expect(response.status).toBe(500)
    expect(cancelSubscriptionMock).toHaveBeenCalledWith(expect.anything(), 'cus_deleted_user')
  })

  it('returns a retryable failure when an RBAC lookup fails', async () => {
    const failedBuilder = queryBuilder([], new Error('Database unavailable'))
    supabaseAdminMock.mockReturnValue({
      from: vi.fn(() => failedBuilder),
    })

    const response = await postDelete()

    expect(response.status).toBe(500)
    expect(cancelSubscriptionMock).not.toHaveBeenCalled()
  })

  it('returns a retryable failure when Stripe cleanup reports a failure', async () => {
    cancelSubscriptionMock.mockResolvedValue(false)
    configureSingleOrgCleanup()

    const response = await postDelete()

    expect(response.status).toBe(500)
    expect(cancelSubscriptionMock).toHaveBeenCalledWith(expect.anything(), 'cus_deleted_user')
  })

  it('runs subscription cleanup while Bento suppression is still pending', async () => {
    let resolveSuppression!: (value: boolean) => void
    syncBentoSubscriberTagsMock.mockImplementationOnce(async () => await new Promise<boolean>((resolve) => {
      resolveSuppression = resolve
    }))
    configureSingleOrgCleanup()

    const responsePromise = postDelete()

    await vi.waitFor(() => {
      expect(cancelSubscriptionMock).toHaveBeenCalledWith(expect.anything(), 'cus_deleted_user')
    })
    expect(unsubscribeBentoMock).not.toHaveBeenCalled()

    resolveSuppression(true)
    const response = await responsePromise
    expect(response.status).toBe(200)
    expect(unsubscribeBentoMock).toHaveBeenCalledOnce()
  })

  it('still submits unsubscribe and returns a retryable failure when suppression hangs', async () => {
    vi.useFakeTimers()
    try {
      syncBentoSubscriberTagsMock.mockImplementationOnce(async () => await new Promise<boolean>(() => {}))

      const responsePromise = postDelete()
      await vi.advanceTimersByTimeAsync(2_001)

      const response = await responsePromise
      expect(response.status).toBe(500)
      expect(unsubscribeBentoMock).toHaveBeenCalledOnce()
      expect(supabaseAdminMock).toHaveBeenCalled()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('bounds a hanging unsubscribe and returns a retryable failure', async () => {
    vi.useFakeTimers()
    try {
      unsubscribeBentoMock.mockImplementationOnce(async () => await new Promise<boolean>(() => {}))

      const responsePromise = postDelete()
      await vi.advanceTimersByTimeAsync(2_001)

      const response = await responsePromise
      expect(response.status).toBe(500)
      expect(syncBentoSubscriberTagsMock).toHaveBeenCalledOnce()
      expect(unsubscribeBentoMock).toHaveBeenCalledOnce()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('continues as a no-op when Bento is not configured', async () => {
    syncBentoSubscriberTagsMock.mockResolvedValue(undefined)
    unsubscribeBentoMock.mockResolvedValue(undefined)

    const response = await postDelete()

    expect(response.status).toBe(200)
  })
})
