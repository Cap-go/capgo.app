import type { Context } from 'hono'
import type { InAppBillingContext } from '../supabase/functions/_backend/utils/stripe_in_app'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ lookup: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/stripe.ts', () => ({ lookupActiveSubscriptionId: mocks.lookup }))
const { applyBillingPromotionCode, getBillingDiscounts } = await import('../supabase/functions/_backend/utils/stripe_promotion_codes')
const redemptionId = '11111111-2222-4333-8444-555555555555'
const discount = {
  id: 'di_example', end: null, source: { coupon: { name: 'Example offer', percent_off: 20, amount_off: null } },
  promotion_code: { id: 'promo_example', code: 'EXAMPLE20' },
}
function fixture() {
  const subscription = {
    id: 'sub_example', customer: 'cus_example', currency: 'usd', status: 'active', schedule: null,
    cancel_at_period_end: false, cancel_at: null, discounts: [] as any[],
    items: { data: [{ price: { product: 'prod_example' }, discounts: [] as any[] }] },
  }
  const promotion = { id: 'promo_example', code: 'EXAMPLE20', active: true, customer: null as any, customer_account: null,
    promotion: { coupon: 'coupon_example' }, restrictions: { first_time_transaction: false, minimum_amount: null as number | null, currency_options: {} } }
  const stripe = {
    customers: { retrieve: vi.fn().mockResolvedValue({ discount: null }) },
    subscriptions: { retrieve: vi.fn().mockResolvedValue(subscription), update: vi.fn().mockResolvedValue({ ...subscription, discounts: [discount] }) },
    promotionCodes: { list: vi.fn().mockResolvedValue({ data: [promotion] }) },
    coupons: { retrieve: vi.fn().mockResolvedValue({ valid: true, applies_to: { products: ['prod_example'] } }) },
  }
  const ctx = { customerId: 'cus_example', billingAccount: 'us', stripe, publishableKey: '' } as unknown as InAppBillingContext
  const c = {} as Context
  const apply = (code: unknown = ' EXAMPLE20 ', replaceExisting: unknown = false) => applyBillingPromotionCode(c, ctx, code, replaceExisting, redemptionId)
  return { stripe, ctx, c, subscription, promotion, apply }
}
beforeEach(() => {
  mocks.lookup.mockResolvedValue({ known: true, subscriptionId: 'sub_example' })
})
describe('subscription promotion codes', () => {
  it('redeems a promotion ID on the resolved account without changing plan or billing cycle', async () => {
    const { apply, stripe } = fixture()
    expect(await apply()).toMatchObject({ discounts: [{ code: 'EXAMPLE20', percentOff: 20 }] })
    expect(stripe.promotionCodes.list).toHaveBeenCalledWith({ code: 'EXAMPLE20', active: true, customer: 'cus_example', limit: 1 })
    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_example', {
      discounts: [{ promotion_code: 'promo_example' }], proration_behavior: 'none', expand: ['discounts.source.coupon', 'discounts.promotion_code'],
    }, { idempotencyKey: `billing-promotion:sub_example:${redemptionId}` })
  })
  it('accepts a public code after checking customer-specific codes', async () => {
    const { apply, stripe, promotion } = fixture()
    stripe.promotionCodes.list.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({ data: [promotion] })
    await apply()
    expect(stripe.promotionCodes.list).toHaveBeenLastCalledWith({ code: 'EXAMPLE20', active: true, limit: 1 })
  })
  it('rejects another customer’s code without revealing it', async () => {
    const { apply, stripe, promotion } = fixture()
    promotion.customer = 'cus_other'
    await expect(apply()).rejects.toMatchObject({ cause: { error: 'invalid_promotion_code' } })
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
  })
  it('never falls back to applying a raw coupon ID', async () => {
    const { apply, stripe } = fixture()
    stripe.promotionCodes.list.mockResolvedValue({ data: [] })
    await expect(apply()).rejects.toThrow()
    expect(stripe.coupons.retrieve).not.toHaveBeenCalled()
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
  })
  it('does not replace an existing discount without explicit confirmation', async () => {
    const { apply, stripe, subscription } = fixture()
    subscription.discounts = ['di_existing']
    await expect(apply()).rejects.toMatchObject({ cause: { error: 'promotion_replace_required' } })
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    await apply('EXAMPLE20', true)
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1)
  })
  it('also requires confirmation before overriding an inherited customer discount', async () => {
    const { apply, stripe } = fixture()
    stripe.customers.retrieve.mockResolvedValue({ discount: { ...discount, promotion_code: null } } as any)
    await expect(apply()).rejects.toMatchObject({ cause: { error: 'promotion_replace_required' } })
  })
  it('recognizes a redeemed code even if it is no longer active', async () => {
    const { apply, stripe, subscription } = fixture()
    subscription.discounts = [discount]
    await expect(apply('example20')).resolves.toMatchObject({ discounts: [{ code: 'EXAMPLE20' }] })
    expect(stripe.promotionCodes.list).not.toHaveBeenCalled()
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
  })
  it.each(['first_time_transaction', 'minimum_amount', 'currency_options'])('rejects checkout-only restrictions: %s', async (restriction) => {
    const { apply, stripe, promotion } = fixture()
    Object.assign(promotion.restrictions, { [restriction]: restriction === 'first_time_transaction' ? true : restriction === 'minimum_amount' ? 5000 : { usd: { minimum_amount: 5000 } } })
    await expect(apply()).rejects.toMatchObject({ cause: { error: 'promotion_checkout_only' } })
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
  })
  it('rejects a product-restricted coupon that would give no discount', async () => {
    const { apply, stripe } = fixture()
    stripe.coupons.retrieve.mockResolvedValue({ valid: true, applies_to: { products: ['prod_other'] } })
    await expect(apply()).rejects.toThrow()
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
  })
  it('propagates Stripe redemption failures rather than reporting success', async () => {
    const { apply, stripe } = fixture()
    stripe.subscriptions.update.mockRejectedValue(new Error('redemption limit reached'))
    await expect(apply()).rejects.toThrow('redemption limit reached')
  })
  it.each(['scheduled', 'ending', 'inactive', 'item-discount', 'wrong-customer'])('does not alter %s subscriptions', async (mode) => {
    const { apply, stripe, subscription } = fixture()
    if (mode === 'scheduled') Object.assign(subscription, { schedule: 'sub_sched_example' })
    if (mode === 'ending') subscription.cancel_at_period_end = true
    if (mode === 'inactive') subscription.status = 'past_due'
    if (mode === 'item-discount') subscription.items.data[0].discounts = ['di_item']
    if (mode === 'wrong-customer') subscription.customer = 'cus_other'
    await expect(apply()).rejects.toThrow()
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
  })
  it('directs customers without a subscription to checkout', async () => {
    mocks.lookup.mockResolvedValue({ known: true, subscriptionId: null })
    const { c, ctx, apply, stripe } = fixture()
    expect(await getBillingDiscounts(c, ctx)).toEqual({ hasSubscription: false, canApply: false, discounts: [] })
    await expect(apply()).rejects.toThrow()
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
  })
  it('does not treat an unavailable subscription lookup as no subscription', async () => {
    mocks.lookup.mockResolvedValue({ known: false, subscriptionId: null })
    const { c, ctx } = fixture()
    await expect(getBillingDiscounts(c, ctx)).rejects.toThrow()
  })
})
