import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  checkPermissionMock,
  supabaseWithAuthMock,
  supabaseAdminMock,
  updateCustomerEmailMock,
  syncBillingBentoTagsFromStoredStripeInfoMock,
} = vi.hoisted(() => ({
  checkPermissionMock: vi.fn(async () => true),
  supabaseWithAuthMock: vi.fn(),
  supabaseAdminMock: vi.fn(),
  updateCustomerEmailMock: vi.fn(async () => undefined),
  syncBillingBentoTagsFromStoredStripeInfoMock: vi.fn(async () => undefined),
}))

vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({
  middlewareAuth: () => async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set('auth', { userId: 'user-123' })
    await next()
  },
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: checkPermissionMock,
}))

vi.mock('../supabase/functions/_backend/utils/stripe.ts', () => ({
  updateCustomerEmail: updateCustomerEmailMock,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseWithAuth: supabaseWithAuthMock,
  supabaseAdmin: supabaseAdminMock,
}))

vi.mock('../supabase/functions/_backend/triggers/stripe_event.ts', () => ({
  syncBillingBentoTagsFromStoredStripeInfo: syncBillingBentoTagsFromStoredStripeInfoMock,
}))

const { app } = await import('../supabase/functions/_backend/private/set_org_email.ts')

const ORG_ID = '11111111-1111-4111-8111-111111111111'
const CUSTOMER_ID = 'cus_billing_email'
const CREATOR_ID = '22222222-2222-4222-8222-222222222222'

function mockOrgLookup(organization: Record<string, unknown> | null) {
  supabaseWithAuthMock.mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: organization, error: null }),
        }),
      }),
    }),
  })
}

function mockOrgUpdate(updatedOrg: { id: string } | null) {
  supabaseAdminMock.mockReturnValue({
    from: () => ({
      update: () => ({
        eq: () => ({
          select: () => ({
            maybeSingle: async () => ({ data: updatedOrg, error: null }),
          }),
        }),
      }),
    }),
  })
}

describe('set_org_email Bento billing tag sync', () => {
  beforeEach(() => {
    checkPermissionMock.mockReset().mockResolvedValue(true)
    updateCustomerEmailMock.mockReset().mockResolvedValue(undefined)
    syncBillingBentoTagsFromStoredStripeInfoMock.mockReset().mockResolvedValue(undefined)
    supabaseWithAuthMock.mockReset()
    supabaseAdminMock.mockReset()
  })

  it('applies billing tags to the new management email after Stripe and DB succeed', async () => {
    mockOrgLookup({
      created_by: CREATOR_ID,
      customer_id: CUSTOMER_ID,
      management_email: 'old-invoices@example.com',
      name: 'Acme',
    })
    mockOrgUpdate({ id: ORG_ID })

    const response = await app.request('http://local/', {
      body: JSON.stringify({
        email: 'invoices@example.com',
        org_id: ORG_ID,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(response.status).toBe(200)
    expect(updateCustomerEmailMock).toHaveBeenCalledWith(expect.anything(), CUSTOMER_ID, 'invoices@example.com')
    expect(syncBillingBentoTagsFromStoredStripeInfoMock).toHaveBeenCalledWith(expect.anything(), {
      created_by: CREATOR_ID,
      customer_id: CUSTOMER_ID,
      id: ORG_ID,
      management_email: 'invoices@example.com',
      name: 'Acme',
    }, CUSTOMER_ID)
  })

  it('does not tag Bento when the org write fails and Stripe is reverted', async () => {
    mockOrgLookup({
      created_by: CREATOR_ID,
      customer_id: CUSTOMER_ID,
      management_email: 'old-invoices@example.com',
      name: 'Acme',
    })
    mockOrgUpdate(null)

    const response = await app.request('http://local/', {
      body: JSON.stringify({
        email: 'invoices@example.com',
        org_id: ORG_ID,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(response.status).toBe(400)
    expect(updateCustomerEmailMock).toHaveBeenNthCalledWith(2, expect.anything(), CUSTOMER_ID, 'old-invoices@example.com')
    expect(syncBillingBentoTagsFromStoredStripeInfoMock).not.toHaveBeenCalled()
  })
})
