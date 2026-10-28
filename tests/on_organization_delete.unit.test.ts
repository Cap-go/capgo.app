import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cancelSubscription = vi.fn(async () => undefined)
const pgQuery = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }))
const STRIPE_INFO_DELETE = 'DELETE FROM public.stripe_info WHERE customer_id = $1'
const storageList = vi.fn(async () => ({ data: [], error: null }))
const storageFrom = vi.fn(() => ({ list: storageList }))
const supabaseAdmin = vi.fn(() => ({
  storage: { from: storageFrom },
}))

vi.mock('../supabase/functions/_backend/utils/stripe.ts', () => ({
  cancelSubscription,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: vi.fn(async () => ({ query: pgQuery })),
  closeClient: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/hono.ts')
  return {
    ...actual,
    middlewareAPISecret: async (_c: unknown, next: () => Promise<void>) => await next(),
  }
})

async function deleteOrg(orgId: string, customerId: string) {
  const { app } = await import('../supabase/functions/_backend/triggers/on_organization_delete.ts')
  return app.request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ table: 'orgs', type: 'DELETE', old_record: { id: orgId, customer_id: customerId } }),
  })
}

describe('on_organization_delete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pgQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    storageList.mockResolvedValue({ data: [], error: null })
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('cancels Stripe subscriptions and deletes stripe_info rows', async () => {
    const orgId = 'org-delete-stripe-info'
    const customerId = 'cus_delete_stripe_info'
    const response = await deleteOrg(orgId, customerId)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    expect(cancelSubscription).toHaveBeenCalledWith(expect.anything(), customerId)
    expect(pgQuery).toHaveBeenCalledWith(STRIPE_INFO_DELETE, [customerId])
    expect(pgQuery).toHaveBeenCalledWith(STRIPE_INFO_DELETE, [`pending_${orgId}`])
  })

  it('still deletes stripe_info when Stripe cancellation fails', async () => {
    cancelSubscription.mockRejectedValueOnce(new Error('stripe unavailable'))
    const orgId = 'org-delete-stripe-info-failure'
    const customerId = 'cus_delete_stripe_info_failure'
    const response = await deleteOrg(orgId, customerId)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    expect(pgQuery).toHaveBeenCalledWith(STRIPE_INFO_DELETE, [customerId])
    expect(pgQuery).toHaveBeenCalledWith(STRIPE_INFO_DELETE, [`pending_${orgId}`])
  })

  it('keeps stripe_info when the customer Stripe account is not configured', async () => {
    const { BillingAccountUnavailableError } = await import('../supabase/functions/_backend/utils/stripe_billing.ts')
    cancelSubscription.mockRejectedValueOnce(new BillingAccountUnavailableError('us'))
    const orgId = 'org-delete-stripe-info-unreachable'
    const customerId = 'cus_delete_stripe_info_unreachable'
    const response = await deleteOrg(orgId, customerId)

    expect(response.status).toBe(200)
    // The row records which Stripe account still bills this customer: never drop it.
    expect(pgQuery).not.toHaveBeenCalledWith(STRIPE_INFO_DELETE, [customerId])
    expect(pgQuery).toHaveBeenCalledWith(STRIPE_INFO_DELETE, [`pending_${orgId}`])
  })
})
