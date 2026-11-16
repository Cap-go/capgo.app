import type { Context } from 'hono'
import type { InAppBillingContext } from '../supabase/functions/_backend/utils/stripe_in_app'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ lookup: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/stripe.ts', () => ({ lookupActiveSubscriptionId: mocks.lookup }))
const { getBillingDiscounts } = await import('../supabase/functions/_backend/utils/stripe_billing_discounts')
const discount = {
  id: 'di_example', end: null, source: { coupon: { name: 'Example offer', percent_off: 20, amount_off: null } },
  promotion_code: { id: 'promo_example', code: 'EXAMPLE20' },
}
function fixture() {
  const subscription = {
    id: 'sub_example', customer: 'cus_example', currency: 'usd', discounts: [] as any[],
    items: { data: [{ discounts: [] as any[] }] },
  }
  const stripe = {
    customers: { retrieve: vi.fn().mockResolvedValue({ discount: null }) },
    subscriptions: { retrieve: vi.fn().mockResolvedValue(subscription), create: vi.fn(), update: vi.fn(), cancel: vi.fn() },
  }
  const ctx = { customerId: 'cus_example', billingAccount: 'us', stripe, publishableKey: '' } as unknown as InAppBillingContext
  const read = () => getBillingDiscounts({} as Context, ctx)
  return { stripe, subscription, read }
}
beforeEach(() => {
  mocks.lookup.mockResolvedValue({ known: true, subscriptionId: 'sub_example' })
})
describe('existing subscription discounts', () => {
  it('reads the applied code without creating, updating or canceling a subscription', async () => {
    const { read, stripe, subscription } = fixture()
    subscription.discounts = [discount]
    expect(await read()).toMatchObject({ discounts: [{ code: 'EXAMPLE20', percentOff: 20 }] })
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_example', { expand: ['discounts.source.coupon', 'discounts.promotion_code'] })
    expect(stripe.subscriptions.create).not.toHaveBeenCalled()
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled()
  })
  it('includes an inherited customer discount', async () => {
    const { read, stripe } = fixture()
    stripe.customers.retrieve.mockResolvedValue({ discount } as any)
    expect(await read()).toMatchObject({ discounts: [{ code: 'EXAMPLE20' }] })
  })
  it('prefers subscription discounts over inherited customer discounts', async () => {
    const { read, stripe, subscription } = fixture()
    subscription.discounts = [discount]
    stripe.customers.retrieve.mockResolvedValue({ discount: { ...discount, promotion_code: { code: 'OTHER' } } } as any)
    expect((await read()).discounts.map(item => item.code)).toEqual(['EXAMPLE20'])
  })
  it('includes item discounts', async () => {
    const { read, subscription } = fixture()
    subscription.items.data[0].discounts = [discount]
    expect(await read()).toMatchObject({ discounts: [{ code: 'EXAMPLE20' }] })
  })
  it('returns no discount without a subscription and does not create one', async () => {
    mocks.lookup.mockResolvedValue({ known: true, subscriptionId: null })
    const { read, stripe } = fixture()
    expect(await read()).toEqual({ discounts: [] })
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
    expect(stripe.subscriptions.create).not.toHaveBeenCalled()
  })
  it('rejects a subscription belonging to another customer', async () => {
    const { read, subscription } = fixture()
    subscription.customer = 'cus_other'
    await expect(read()).rejects.toThrow()
  })
  it('rejects deleted customers', async () => {
    const { read, stripe } = fixture()
    stripe.customers.retrieve.mockResolvedValue({ deleted: true } as any)
    await expect(read()).rejects.toThrow()
  })
  it('does not treat an unavailable lookup as an absent discount', async () => {
    mocks.lookup.mockResolvedValue({ known: false, subscriptionId: null })
    await expect(fixture().read()).rejects.toThrow()
  })
})
