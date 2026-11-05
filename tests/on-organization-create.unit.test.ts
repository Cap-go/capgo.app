import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createStripeCustomerMock,
  finalizePendingStripeCustomerMock,
  backgroundTaskMock,
  supabaseAdminMock,
  syncOrgOnboardingIntentForOrgMock,
  sendEventToTrackingMock,
  resolveSignupAttributionForUserMock,
  resolveSignupAttributionForOrgMock,
  orgSignupPluginUpdateMock,
  pgQueryMock,
  syncBentoSubscriberTagsMock,
  creatorMetadata,
} = vi.hoisted(() => ({
  syncBentoSubscriberTagsMock: vi.fn(async (..._args: unknown[]) => undefined),
  creatorMetadata: { value: {} as Record<string, unknown> | Error },
  createStripeCustomerMock: vi.fn(async () => 'Solo'),
  finalizePendingStripeCustomerMock: vi.fn(async () => 'Solo'),
  backgroundTaskMock: vi.fn(async (c: unknown, task: unknown) => task),
  supabaseAdminMock: vi.fn(),
  syncOrgOnboardingIntentForOrgMock: vi.fn(async () => undefined),
  sendEventToTrackingMock: vi.fn(async () => undefined),
  resolveSignupAttributionForUserMock: vi.fn(async () => ({})),
  resolveSignupAttributionForOrgMock: vi.fn(async () => ({})),
  orgSignupPluginUpdateMock: vi.fn(),
  pgQueryMock: vi.fn(async (_sql: string, _params?: unknown[]): Promise<{ rows: unknown[], rowCount?: number }> => ({ rows: [] })),
}))

vi.mock('../supabase/functions/_backend/utils/stripe_org.ts', () => ({
  createStripeCustomer: createStripeCustomerMock,
  finalizePendingStripeCustomer: finalizePendingStripeCustomerMock,
  isPendingStripeCustomerId: (customerId: string | null | undefined) => Boolean(customerId?.startsWith('pending_')),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: supabaseAdminMock,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: vi.fn(async () => ({ query: pgQueryMock })),
  closeClient: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/utils.ts')
  return {
    ...actual,
    backgroundTask: backgroundTaskMock,
  }
})

vi.mock('../supabase/functions/_backend/utils/org_onboarding_intent.ts', () => ({
  parseOrgOnboardingIntent: () => 'ota',
  buildOnboardingIntentBentoEventData: () => ({ org_id: 'org' }),
  syncOrgOnboardingIntentForOrg: syncOrgOnboardingIntentForOrgMock,
}))

vi.mock('../supabase/functions/_backend/utils/tracking.ts', () => ({
  sendEventToTracking: sendEventToTrackingMock,
}))

vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({
  syncBentoSubscriberTags: syncBentoSubscriberTagsMock,
}))

vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({
  groupIdentifyPosthog: vi.fn(async () => undefined),
}))

vi.mock('../supabase/functions/_backend/utils/signup_attribution.ts', () => ({
  resolveSignupAttributionForUser: resolveSignupAttributionForUserMock,
  resolveSignupAttributionForOrg: resolveSignupAttributionForOrgMock,
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/hono.ts')
  return {
    ...actual,
    middlewareAPISecret: async (_c: unknown, next: () => Promise<void>) => await next(),
  }
})

const ORG_ID = 'b0dfb856-7ed2-4420-bfca-64d67fe65a4e'
const USER_ID = '550e8400-e29b-41d4-a716-446655440000'
const CREATED_AT = '2026-10-01T12:00:00.000Z'

/** Builds an org fixture with a stable creator UUID and database creation time. */
function createOrg(customerId: string | null) {
  return {
    id: ORG_ID,
    created_by: USER_ID,
    created_at: CREATED_AT,
    customer_id: customerId,
    management_email: 'owner@example.com',
    name: 'WN Hub',
    website: null,
    onboarding: { intent: 'ota' },
  }
}

function mockOrgReload(customerId: string | null) {
  supabaseAdminMock.mockImplementation(() => ({
    auth: {
      admin: {
        getUserById: async () => creatorMetadata.value instanceof Error
          ? { data: { user: null }, error: creatorMetadata.value }
          : { data: { user: { app_metadata: creatorMetadata.value } }, error: null },
      },
    },
  }))
  pgQueryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM public.orgs WHERE id = $1'))
      return { rows: [{ row: createOrg(customerId) }] }
    if (sql.startsWith('UPDATE public.orgs SET signup_plugin')) {
      orgSignupPluginUpdateMock({ signup_plugin: params[0] })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('FROM public.users WHERE id = $1'))
      return { rows: [{ email: 'owner@example.com' }] }
    throw new Error(`unexpected query ${sql}`)
  })
}

describe('on_organization_create stripe bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    backgroundTaskMock.mockImplementation(async (_c: unknown, task: unknown) => task)
    createStripeCustomerMock.mockResolvedValue('Solo')
    finalizePendingStripeCustomerMock.mockResolvedValue('Solo')
    resolveSignupAttributionForUserMock.mockResolvedValue({})
    resolveSignupAttributionForOrgMock.mockResolvedValue({})
    creatorMetadata.value = {}
  })

  it('tags standard trial creators with the trial plan in Bento', async () => {
    mockOrgReload(`pending_${ORG_ID}`)
    const { app } = await import('../supabase/functions/_backend/triggers/on_organization_create.ts')

    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'orgs', type: 'INSERT', record: createOrg(null) }),
    })

    expect(response.status).toBe(200)
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(expect.anything(), {
      email: 'owner@example.com',
      segments: ['trial-plan:Solo'],
      deleteSegments: [],
    })
  })

  it('tags direct-offer creators offer=direct without any trial tag', async () => {
    creatorMetadata.value = { offer: 'direct' }
    mockOrgReload(`pending_${ORG_ID}`)
    const { app } = await import('../supabase/functions/_backend/triggers/on_organization_create.ts')

    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'orgs', type: 'INSERT', record: createOrg(null) }),
    })

    expect(response.status).toBe(200)
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(expect.anything(), {
      email: 'owner@example.com',
      segments: ['offer=direct'],
      deleteSegments: ['trial-plan:Solo', 'trial', 'trial7', 'trial1', 'trial0', 'trial-card-on-file'],
    })
    const sentSegments = (syncBentoSubscriberTagsMock.mock.calls as unknown as Array<[unknown, { segments: string[] }]>)
      .flatMap(call => call[1].segments)
    expect(sentSegments.some(tag => tag.startsWith('trial'))).toBe(false)
  })

  it('skips trial tags when the direct-offer lookup fails', async () => {
    creatorMetadata.value = new Error('auth unavailable')
    mockOrgReload(`pending_${ORG_ID}`)
    const { app } = await import('../supabase/functions/_backend/triggers/on_organization_create.ts')

    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'orgs', type: 'INSERT', record: createOrg(null) }),
    })

    expect(response.status).toBe(200)
    const sentSegments = (syncBentoSubscriberTagsMock.mock.calls as unknown as Array<[unknown, { segments: string[] }]>)
      .flatMap(call => call[1].segments)
    expect(sentSegments.some(tag => tag.startsWith('trial') || tag === 'offer=direct')).toBe(false)
  })

  it('persists signup_plugin and attaches attribution tags on Org Created', async () => {
    resolveSignupAttributionForUserMock.mockResolvedValue({
      signup_plugin: 'capacitor-updater',
      signup_source: 'plugin_capacitor-updater',
      first_touch_type: 'plugin',
    })
    resolveSignupAttributionForOrgMock.mockResolvedValue({
      signup_plugin: 'capacitor-updater',
      signup_source: 'plugin_capacitor-updater',
      first_touch_type: 'plugin',
    })
    mockOrgReload('cus_already_linked')
    const { app } = await import('../supabase/functions/_backend/triggers/on_organization_create.ts')

    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        table: 'orgs',
        type: 'INSERT',
        record: createOrg(null),
      }),
    })

    expect(response.status).toBe(200)
    expect(orgSignupPluginUpdateMock).toHaveBeenCalledWith({ signup_plugin: 'capacitor-updater' })
    expect(sendEventToTrackingMock).toHaveBeenCalled()
    const trackingCalls = sendEventToTrackingMock.mock.calls as unknown as Array<
      [_context: unknown, payload: { event?: string, user_id?: string, tags?: Record<string, unknown> }]
    >
    const trackingPayload = trackingCalls.find(call => call[1]?.event === 'Org Created')?.[1]
    expect(trackingPayload).toMatchObject({
      bento: { once: true, uniqId: `org:created:${ORG_ID}` },
      user_id: USER_ID,
      occurred_at: CREATED_AT,
      nonPersonTags: {
        org_id: ORG_ID,
        $insert_id: `org-created:${ORG_ID}`,
        capture_source: 'database_trigger',
      },
      tags: {
        owner_org: ORG_ID,
        signup_plugin: 'capacitor-updater',
        signup_source: 'plugin_capacitor-updater',
        first_touch_type: 'plugin',
      },
    })
  })

  it('retains business time and deduplication identity on delayed queue retries', async () => {
    mockOrgReload('cus_already_linked')
    const { app } = await import('../supabase/functions/_backend/triggers/on_organization_create.ts')
    /** Replays the same committed insert payload to exercise delayed delivery. */
    const request = () => app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'orgs', type: 'INSERT', record: createOrg(null) }),
    })
    await request()
    await request()
    const calls = sendEventToTrackingMock.mock.calls as unknown as Array<[unknown, Record<string, any>, unknown]>
    expect(calls).toHaveLength(2)
    expect(calls[0][1].occurred_at).toBe(CREATED_AT)
    expect(calls[1][1].occurred_at).toBe(CREATED_AT)
    expect(calls[1][1].nonPersonTags.$insert_id).toBe(calls[0][1].nonPersonTags.$insert_id)
    expect(calls[0][2]).toEqual({ background: false, strict: true, requirePosthogDelivery: true })
  })

  it('does not emit a creation event for a non-insert queue payload', async () => {
    const { app } = await import('../supabase/functions/_backend/triggers/on_organization_create.ts')
    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'orgs', type: 'UPDATE', record: createOrg(null) }),
    })
    expect(response.status).toBe(400)
    expect(sendEventToTrackingMock).not.toHaveBeenCalled()
  })

  it('never replaces a missing database timestamp with delivery time', async () => {
    const { app } = await import('../supabase/functions/_backend/triggers/on_organization_create.ts')
    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'orgs', type: 'INSERT', record: { ...createOrg(null), created_at: null } }),
    })
    expect(response.status).toBe(400)
    expect(sendEventToTrackingMock).not.toHaveBeenCalled()
  })

  it('does not create a Stripe customer when reload finds a real customer_id', async () => {
    mockOrgReload('cus_already_linked')
    const { app } = await import('../supabase/functions/_backend/triggers/on_organization_create.ts')

    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        table: 'orgs',
        type: 'INSERT',
        record: createOrg(null),
      }),
    })

    expect(response.status).toBe(200)
    expect(createStripeCustomerMock).not.toHaveBeenCalled()
    expect(finalizePendingStripeCustomerMock).not.toHaveBeenCalled()
  })

  it('finalizes a pending customer_id from the reloaded org row', async () => {
    mockOrgReload(`pending_${ORG_ID}`)
    const { app } = await import('../supabase/functions/_backend/triggers/on_organization_create.ts')

    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        table: 'orgs',
        type: 'INSERT',
        record: createOrg(null),
      }),
    })

    expect(response.status).toBe(200)
    expect(createStripeCustomerMock).not.toHaveBeenCalled()
    expect(finalizePendingStripeCustomerMock).toHaveBeenCalledTimes(1)
  })

  it('routes Bento onboarding sync through a background task', async () => {
    let resolveOnboarding: (value?: undefined) => void = () => {}
    const onboardingPromise = new Promise<undefined>((resolve) => {
      resolveOnboarding = resolve
    })
    syncOrgOnboardingIntentForOrgMock.mockReturnValue(onboardingPromise)
    backgroundTaskMock.mockImplementation(async () => null)
    mockOrgReload(`pending_${ORG_ID}`)
    const { app } = await import('../supabase/functions/_backend/triggers/on_organization_create.ts')

    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        table: 'orgs',
        type: 'INSERT',
        record: createOrg(null),
      }),
    })

    expect(response.status).toBe(200)
    expect(syncOrgOnboardingIntentForOrgMock).toHaveBeenCalledTimes(1)
    expect(backgroundTaskMock.mock.calls.some(call => call[1] instanceof Promise)).toBe(true)
    resolveOnboarding()
  })

  it('keeps the trigger successful when onboarding sync fails', async () => {
    syncOrgOnboardingIntentForOrgMock.mockRejectedValue(new Error('bento down'))
    mockOrgReload(`pending_${ORG_ID}`)
    const { app } = await import('../supabase/functions/_backend/triggers/on_organization_create.ts')

    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        table: 'orgs',
        type: 'INSERT',
        record: createOrg(null),
      }),
    })

    expect(response.status).toBe(200)
    expect(syncOrgOnboardingIntentForOrgMock).toHaveBeenCalledTimes(1)
  })
})
