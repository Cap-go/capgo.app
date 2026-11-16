import type { Context } from 'hono'
import type Stripe from 'stripe'
import type { InAppBillingContext } from './stripe_in_app.ts'
import { simpleError } from './hono.ts'
import { lookupActiveSubscriptionId } from './stripe.ts'

export interface BillingDiscount {
  name: string | null
  code: string | null
  percentOff: number | null
  amountOff: number | null
  currency: string | null
  endsAt: string | null
}

async function getPromotionContext(c: Context, ctx: InAppBillingContext) {
  const lookup = await lookupActiveSubscriptionId(c, ctx.customerId)
  if (!lookup.known)
    throw simpleError('billing_unavailable', 'Billing is temporarily unavailable')
  if (!lookup.subscriptionId)
    return null
  const [subscription, customer] = await Promise.all([
    ctx.stripe.subscriptions.retrieve(lookup.subscriptionId, { expand: ['discounts.source.coupon', 'discounts.promotion_code'] }),
    ctx.stripe.customers.retrieve(ctx.customerId, { expand: ['discount.source.coupon', 'discount.promotion_code'] }),
  ])
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
  if (customer.deleted || customerId !== ctx.customerId)
    throw simpleError('billing_unavailable', 'Billing is temporarily unavailable')
  const customerDiscounts = customer.discount ? [customer.discount] : []
  const inherited = subscription.discounts.length ? subscription.discounts : customerDiscounts
  const discounts = [...inherited, ...subscription.items.data.flatMap(item => item.discounts ?? [])]
  return { subscription, discounts }
}

function canApply(subscription: Stripe.Subscription) {
  // Scheduled phases and item-level discounts need coordinated changes, not a subscription override.
  return ['active', 'trialing'].includes(subscription.status)
    && !subscription.schedule
    && !subscription.cancel_at_period_end
    && !subscription.cancel_at
    && !subscription.items.data.some(item => item.discounts?.length)
}

function summarizeDiscount(discount: string | Stripe.Discount, currency: string): BillingDiscount {
  if (typeof discount === 'string')
    return { name: null, code: null, percentOff: null, amountOff: null, currency: null, endsAt: null }
  const coupon = discount.source.coupon
  const details = coupon && typeof coupon === 'object' ? coupon : null
  const amountOff = details?.currency_options?.[currency]?.amount_off ?? (details?.currency === currency ? details.amount_off : null)
  return {
    name: details?.name ?? null,
    code: typeof discount.promotion_code === 'object' ? discount.promotion_code?.code ?? null : null,
    percentOff: details?.percent_off ?? null,
    amountOff,
    currency: amountOff !== null ? currency : null,
    endsAt: discount.end ? new Date(discount.end * 1000).toISOString() : null,
  }
}

export async function getBillingDiscounts(c: Context, ctx: InAppBillingContext) {
  const current = await getPromotionContext(c, ctx)
  return {
    hasSubscription: !!current,
    canApply: !!current && canApply(current.subscription),
    discounts: current?.discounts.map(discount => summarizeDiscount(discount, current.subscription.currency)) ?? [],
  }
}

export async function applyBillingPromotionCode(c: Context, ctx: InAppBillingContext, value: unknown, replaceExisting: unknown, redemptionId: unknown) {
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(value.trim()))
    throw simpleError('invalid_promotion_code', 'Enter a valid promotion code')
  if (typeof redemptionId !== 'string' || !/^[a-f0-9-]{36}$/i.test(redemptionId))
    throw simpleError('invalid_redemption_id', 'Invalid redemption request')
  const code = value.trim()
  const current = await getPromotionContext(c, ctx)
  if (!current || !canApply(current.subscription))
    throw simpleError('promotion_code_unavailable', 'This subscription cannot be updated with a promotion code')

  // A used-up or archived promotion is no longer listed, but an existing redemption is still valid.
  if (current.discounts.some(discount => typeof discount !== 'string'
    && typeof discount.promotion_code === 'object'
    && discount.promotion_code?.code.toLowerCase() === code.toLowerCase())) {
    return { discounts: current.discounts.map(discount => summarizeDiscount(discount, current.subscription.currency)) }
  }

  // Customer-specific codes can share the same text. Query this customer first rather
  // than scanning other customers' codes or accidentally redeeming one of theirs.
  const targeted = await ctx.stripe.promotionCodes.list({ code, active: true, customer: ctx.customerId, limit: 1 })
  const candidates = targeted.data.length
    ? targeted.data
    : (await ctx.stripe.promotionCodes.list({ code, active: true, limit: 1 })).data
  const promotion = candidates.find((item) => {
    const customer = typeof item.customer === 'string' ? item.customer : item.customer?.id
    return !item.customer_account && (!customer || customer === ctx.customerId)
  })
  if (!promotion?.active)
    throw simpleError('invalid_promotion_code', 'This promotion code is not available for this subscription')

  // Return success after a lost response without consuming another redemption.
  if (current.discounts.some(discount => typeof discount !== 'string'
    && (typeof discount.promotion_code === 'string' ? discount.promotion_code : discount.promotion_code?.id) === promotion.id)) {
    return { discounts: current.discounts.map(discount => summarizeDiscount(discount, current.subscription.currency)) }
  }
  if (current.discounts.length && replaceExisting !== true)
    throw simpleError('promotion_replace_required', 'Confirm replacement of the existing discount')

  // Stripe does not support minimum-spend codes on subscription updates. A customer
  // with an existing subscription is not a first-time checkout customer either.
  if (promotion.restrictions.first_time_transaction || promotion.restrictions.minimum_amount != null
    || Object.values(promotion.restrictions.currency_options ?? {}).some(option => option.minimum_amount != null))
    throw simpleError('promotion_checkout_only', 'This promotion code can only be used at an eligible checkout')
  const couponRef = promotion.promotion.coupon
  const coupon = typeof couponRef === 'string' ? await ctx.stripe.coupons.retrieve(couponRef) : couponRef
  const products = new Set(current.subscription.items.data.map(item => typeof item.price.product === 'string' ? item.price.product : item.price.product.id))
  if (!coupon?.valid || (coupon.applies_to?.products?.length && !coupon.applies_to.products.some(product => products.has(product))))
    throw simpleError('invalid_promotion_code', 'This promotion code is not available for this subscription')

  // Redeem the promotion ID, never its underlying coupon: Stripe must enforce expiry,
  // redemption limits and customer restrictions. No price, quantity or cycle changes.
  const updated = await ctx.stripe.subscriptions.update(current.subscription.id, {
    discounts: [{ promotion_code: promotion.id }],
    proration_behavior: 'none',
    expand: ['discounts.source.coupon', 'discounts.promotion_code'],
  }, { idempotencyKey: `billing-promotion:${current.subscription.id}:${redemptionId}` })
  return { discounts: updated.discounts.map(discount => summarizeDiscount(discount, updated.currency)) }
}
