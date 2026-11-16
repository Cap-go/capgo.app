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

async function getDiscountContext(c: Context, ctx: InAppBillingContext) {
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
  const current = await getDiscountContext(c, ctx)
  return {
    discounts: current?.discounts.map(discount => summarizeDiscount(discount, current.subscription.currency)) ?? [],
  }
}
