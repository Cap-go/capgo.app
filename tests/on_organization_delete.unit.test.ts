import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cancelSubscription = vi.fn(async () => undefined)
const stripeInfoDeleteEq = vi.fn(async () => ({ error: null }))
const stripeInfoDelete = vi.fn(() => ({ eq: stripeInfoDeleteEq }))
const stripeInfoFrom = vi.fn(() => ({ delete: stripeInfoDelete }))
const storageList = vi.fn(async () => ({ data: [], error: null }))
const storageFrom = vi.fn(() => ({ list: storageList }))
const supabaseAdmin = vi.fn(() => ({
  from: stripeInfoFrom,
  storage: { from: storageFrom },
}))

vi.mock('../supabase/functions/_backend/utils/stripe.ts', () => ({
  cancelSubscription,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin,
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/hono.ts')
  return {
    ...actual,
    middlewareAPISecret: async (_c: unknown, next: () => Promise<void>) => await next(),
  }
})

describe('on_organization_delete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stripeInfoDeleteEq.mockResolvedValue({ error: null })
    storageList.mockResolvedValue({ data: [], error: null })
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('cancels Stripe subscriptions and deletes stripe_info rows', async () => {
    const { app } = await import('../supabase/functions/_backend/triggers/on_organization_delete.ts')
    const orgId = 'org-delete-stripe-info'
    const customerId = 'cus_delete_stripe_info'

    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        table: 'orgs',
        type: 'DELETE',
        old_record: {
          id: orgId,
          customer_id: customerId,
        },
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    expect(cancelSubscription).toHaveBeenCalledWith(expect.anything(), customerId)
    expect(stripeInfoFrom).toHaveBeenCalledWith('stripe_info')
    expect(stripeInfoDeleteEq).toHaveBeenCalledWith('customer_id', customerId)
    expect(stripeInfoDeleteEq).toHaveBeenCalledWith('customer_id', `pending_${orgId}`)
  })

  it('still deletes stripe_info when Stripe cancellation fails', async () => {
    cancelSubscription.mockRejectedValueOnce(new Error('stripe unavailable'))
    const { app } = await import('../supabase/functions/_backend/triggers/on_organization_delete.ts')
    const orgId = 'org-delete-stripe-info-failure'
    const customerId = 'cus_delete_stripe_info_failure'

    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        table: 'orgs',
        type: 'DELETE',
        old_record: {
          id: orgId,
          customer_id: customerId,
        },
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    expect(stripeInfoDeleteEq).toHaveBeenCalledWith('customer_id', customerId)
    expect(stripeInfoDeleteEq).toHaveBeenCalledWith('customer_id', `pending_${orgId}`)
  })
})
