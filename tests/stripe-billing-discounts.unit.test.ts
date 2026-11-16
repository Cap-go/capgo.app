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
    items: { data: [{ id: 'si_example', discounts: [] as any[] }] },
  }
  const stripe = {
    customers: { retrieve: vi.fn().mockResolvedValue({ discount: null }) },
    subscriptions: { retrieve: vi.fn().mockResolvedValue(subscription), create: vi.fn(), update: vi.fn(), cancel: vi.fn() },
    subscriptionItems: { retrieve: vi.fn() },
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
    expect(stripe.subscriptionItems.retrieve).not.toHaveBeenCalled()
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
  it.each(['percentage', 'amount'])('expands an item discount before displaying its %s, code and expiry', async (kind) => {
    const { read, subscription, stripe } = fixture()
    subscription.items.data[0].discounts = ['di_example']
    const coupon = kind === 'percentage'
      ? discount.source.coupon
      : { name: 'Example offer', percent_off: null, amount_off: 500, currency: 'usd' }
    stripe.subscriptionItems.retrieve.mockImplementation(async (_id: string, params: { expand?: string[] }) => ({
      id: 'si_example',
      subscription: 'sub_example',
      // Stripe returns IDs until the request explicitly expands each field.
      discounts: params.expand?.some(field => field.startsWith('discounts.'))
        ? [{
            ...discount,
            end: 1893456000,
            source: { coupon: params.expand.includes('discounts.source.coupon') ? coupon : 'coupon_example' },
            promotion_code: params.expand.includes('discounts.promotion_code') ? discount.promotion_code : 'promo_example',
          }]
        : ['di_example'],
    }))
    expect(await read()).toMatchObject({ discounts: [{
      code: 'EXAMPLE20',
      percentOff: kind === 'percentage' ? 20 : null,
      amountOff: kind === 'amount' ? 500 : null,
      currency: kind === 'amount' ? 'usd' : null,
      endsAt: '2030-01-01T00:00:00.000Z',
    }] })
    expect(stripe.subscriptionItems.retrieve).toHaveBeenCalledWith('si_example', {
      expand: ['discounts.source.coupon', 'discounts.promotion_code'],
    })
    expect(stripe.subscriptions.create).not.toHaveBeenCalled()
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled()
  })
  it('retrieves only items with discounts', async () => {
    const { read, subscription, stripe } = fixture()
    subscription.items.data.push({ id: 'si_discounted', discounts: ['di_example'] })
    stripe.subscriptionItems.retrieve.mockResolvedValue({ discounts: [discount] })
    expect(await read()).toMatchObject({ discounts: [{ code: 'EXAMPLE20' }] })
    expect(stripe.subscriptionItems.retrieve).toHaveBeenCalledTimes(1)
    expect(stripe.subscriptionItems.retrieve).toHaveBeenCalledWith('si_discounted', expect.anything())
  })
  it('returns no discount without a subscription and does not create one', async () => {
    mocks.lookup.mockResolvedValue({ known: true, subscriptionId: null })
    const { read, stripe } = fixture()
    expect(await read()).toEqual({ discounts: [] })
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
    expect(stripe.subscriptions.create).not.toHaveBeenCalled()
  })
  it('rejects a subscription belonging to another customer', async () => {
    const { read, subscription, stripe } = fixture()
    subscription.customer = 'cus_other'
    subscription.items.data[0].discounts = ['di_example']
    await expect(read()).rejects.toThrow()
    expect(stripe.subscriptionItems.retrieve).not.toHaveBeenCalled()
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
