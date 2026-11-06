import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  checkPermissionMock,
  orgLookupMock,
  orgUpdateMock,
  withRlsContextMock,
  updateCustomerEmailMock,
  syncBillingBentoTagsFromStoredStripeInfoMock,
} = vi.hoisted(() => ({
  checkPermissionMock: vi.fn(async () => true),
  orgLookupMock: vi.fn(),
  orgUpdateMock: vi.fn(),
  withRlsContextMock: vi.fn(),
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

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/pg_rls.ts')>()
  return {
    ...actual,
    authPrincipal: (_c: unknown, auth: { userId: string }) => ({ kind: 'jwt', userId: auth.userId }),
    withRlsContext: withRlsContextMock,
  }
})

// The org read runs as the caller (withRlsContext), the write on the connection role (getPgClient).
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: () => undefined,
  getPgClient: async () => ({
    query: async (text: string, values: unknown[]) => {
      if (!text.startsWith('UPDATE public.orgs SET management_email'))
        throw new Error(`unexpected query ${text}`)
      const updatedOrg = orgUpdateMock(values)
      return { rows: updatedOrg ? [updatedOrg] : [] }
    },
  }),
}))

vi.mock('../supabase/functions/_backend/triggers/stripe_event.ts', () => ({
  syncBillingBentoTagsFromStoredStripeInfo: syncBillingBentoTagsFromStoredStripeInfoMock,
}))

const { app } = await import('../supabase/functions/_backend/private/set_org_email.ts')

const ORG_ID = '11111111-1111-4111-8111-111111111111'
const CUSTOMER_ID = 'cus_billing_email'
const CREATOR_ID = '22222222-2222-4222-8222-222222222222'

function mockOrgLookup(organization: Record<string, unknown> | null) {
  withRlsContextMock.mockImplementation(async (_c: unknown, _principal: unknown, run: (client: unknown) => unknown) => run({
    query: async (text: string, values: unknown[]) => {
      if (!text.includes('FROM public.orgs WHERE id = $1'))
        throw new Error(`unexpected query ${text}`)
      orgLookupMock(values)
      return { rows: organization ? [{ row: organization }] : [] }
    },
  }))
}

function mockOrgUpdate(updatedOrg: { id: string } | null) {
  orgUpdateMock.mockReturnValue(updatedOrg)
}

describe('set_org_email Bento billing tag sync', () => {
  beforeEach(() => {
    checkPermissionMock.mockReset().mockResolvedValue(true)
    updateCustomerEmailMock.mockReset().mockResolvedValue(undefined)
    syncBillingBentoTagsFromStoredStripeInfoMock.mockReset().mockResolvedValue(undefined)
    orgLookupMock.mockReset()
    orgUpdateMock.mockReset()
    withRlsContextMock.mockReset()
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
    expect(orgLookupMock).toHaveBeenCalledWith([ORG_ID])
    expect(orgUpdateMock).toHaveBeenCalledWith(['invoices@example.com', ORG_ID])
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
