import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createStripeCustomerMock,
  finalizePendingStripeCustomerMock,
  backgroundTaskMock,
  supabaseAdminMock,
  syncOrgOnboardingIntentForOrgMock,
  sendEventToTrackingMock,
} = vi.hoisted(() => ({
  createStripeCustomerMock: vi.fn(async () => 'Solo'),
  finalizePendingStripeCustomerMock: vi.fn(async () => 'Solo'),
  backgroundTaskMock: vi.fn(async (c: unknown, task: unknown) => task),
  supabaseAdminMock: vi.fn(),
  syncOrgOnboardingIntentForOrgMock: vi.fn(async () => undefined),
  sendEventToTrackingMock: vi.fn(async () => undefined),
}))

vi.mock('../supabase/functions/_backend/utils/stripe_org.ts', () => ({
  createStripeCustomer: createStripeCustomerMock,
  finalizePendingStripeCustomer: finalizePendingStripeCustomerMock,
  isPendingStripeCustomerId: (customerId: string | null | undefined) => Boolean(customerId?.startsWith('pending_')),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: supabaseAdminMock,
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
  syncBentoSubscriberTags: vi.fn(async () => undefined),
}))

vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({
  groupIdentifyPosthog: vi.fn(async () => undefined),
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/hono.ts')
  return {
    ...actual,
    middlewareAPISecret: async (_c: unknown, next: () => Promise<void>) => await next(),
  }
})

const ORG_ID = 'b0dfb856-7ed2-4420-bfca-64d67fe65a4e'

function createOrg(customerId: string | null) {
  return {
    id: ORG_ID,
    created_by: 'user-1',
    customer_id: customerId,
    management_email: 'owner@example.com',
    name: 'WN Hub',
    website: null,
    onboarding: { intent: 'ota' },
  }
}

function mockOrgReload(customerId: string | null) {
  supabaseAdminMock.mockImplementation(() => ({
    from: (table: string) => {
      if (table === 'orgs') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: createOrg(customerId), error: null }),
            }),
          }),
        }
      }
      if (table === 'users') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { email: 'owner@example.com' }, error: null }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }))
}

describe('on_organization_create stripe bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    backgroundTaskMock.mockImplementation(async (_c: unknown, task: unknown) => task)
    createStripeCustomerMock.mockResolvedValue('Solo')
    finalizePendingStripeCustomerMock.mockResolvedValue('Solo')
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
