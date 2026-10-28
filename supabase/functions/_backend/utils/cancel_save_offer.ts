import type { Context } from 'hono'
import type { CancelFeedback, InAppBillingContext } from './stripe_in_app.ts'
import Stripe from 'stripe'
import { simpleError } from './hono.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { closeClient, getPgClient } from './pg.ts'
import { getActiveSubscriptionId, syncSubscriptionData } from './stripe.ts'

// Cancel flow save offer: a monthly customer who starts to cancel is offered a
// discount on the next months instead. Each offer and its outcome is stored in
// public.cancel_save_offers so the admin dashboard can chart saves over time and
// whether customers kept paying once the discount ended.

export const CANCEL_SAVE_OFFER_PERCENT_OFF = 50
export const CANCEL_SAVE_OFFER_DURATION_MONTHS = 3
// Same id in both Stripe accounts; created on first use.
export const CANCEL_SAVE_COUPON_ID = `capgo_cancel_save_${CANCEL_SAVE_OFFER_PERCENT_OFF}_${CANCEL_SAVE_OFFER_DURATION_MONTHS}m`
// A reopened cancel dialog reuses the unanswered offer instead of counting a new one.
const OFFER_REUSE_HOURS = 24

export interface CancelSaveOffer {
  id: string
  percentOff: number
  durationMonths: number
  monthlyAmount: number
  discountedAmount: number
  currency: string
}

interface OfferRow {
  id: string
  subscription_id: string
  monthly_amount: string | number
  currency: string
  percent_off: number
  duration_months: number
}

function toOffer(row: OfferRow): CancelSaveOffer {
  const monthlyAmount = Number(row.monthly_amount)
  return {
    id: row.id,
    percentOff: row.percent_off,
    durationMonths: row.duration_months,
    monthlyAmount,
    discountedAmount: Math.round(monthlyAmount * (100 - row.percent_off) / 100),
    currency: row.currency,
  }
}

/**
 * The monthly price the discount would apply to, or null when the subscription
 * cannot be saved this way: not active, already ending, already discounted, or
 * billed on anything other than one month.
 */
export function getSaveableMonthlyAmount(subscription: Stripe.Subscription): { amount: number, currency: string } | null {
  if (subscription.status !== 'active' || subscription.cancel_at_period_end || subscription.cancel_at)
    return null
  if ((subscription.discounts ?? []).length > 0)
    return null
  let amount = 0
  for (const item of subscription.items.data) {
    const recurring = item.price.recurring
    if (!recurring || recurring.interval !== 'month' || recurring.interval_count !== 1)
      return null
    // Metered usage is billed in arrears and does not set the plan price.
    if (recurring.usage_type === 'metered')
      continue
    amount += (item.price.unit_amount ?? 0) * (item.quantity ?? 1)
  }
  return amount > 0 ? { amount, currency: subscription.currency } : null
}

async function ensureCoupon(stripe: Stripe) {
  try {
    await stripe.coupons.retrieve(CANCEL_SAVE_COUPON_ID)
  }
  catch (error) {
    if (!(error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'resource_missing'))
      throw error
    try {
      await stripe.coupons.create({
        id: CANCEL_SAVE_COUPON_ID,
        name: `Stay with Capgo: ${CANCEL_SAVE_OFFER_PERCENT_OFF}% off for ${CANCEL_SAVE_OFFER_DURATION_MONTHS} months`,
        percent_off: CANCEL_SAVE_OFFER_PERCENT_OFF,
        duration: 'repeating',
        duration_in_months: CANCEL_SAVE_OFFER_DURATION_MONTHS,
      })
    }
    catch (createError) {
      // Another request created it first.
      if (!(createError instanceof Stripe.errors.StripeInvalidRequestError && createError.code === 'resource_already_exists'))
        throw createError
    }
  }
}

async function withPg<T>(c: Context, run: (pg: Awaited<ReturnType<typeof getPgClient>>) => Promise<T>): Promise<T> {
  const pg = await getPgClient(c)
  try {
    return await run(pg)
  }
  finally {
    await closeClient(c, pg)
  }
}

async function retrieveSubscription(ctx: InAppBillingContext, subscriptionId: string) {
  return await ctx.stripe.subscriptions.retrieve(subscriptionId, { expand: ['discounts'] })
}

/** The offer to show before canceling, or null when this customer is not eligible. */
export async function prepareCancelSaveOffer(c: Context, ctx: InAppBillingContext, orgId: string, reason: CancelFeedback): Promise<CancelSaveOffer | null> {
  const subscriptionId = await getActiveSubscriptionId(c, ctx.customerId)
  if (!subscriptionId)
    return null
  const saveable = getSaveableMonthlyAmount(await retrieveSubscription(ctx, subscriptionId))
  if (!saveable)
    return null

  return await withPg(c, async (pg) => {
    const { rows: accepted } = await pg.query(
      `SELECT 1 FROM public.cancel_save_offers WHERE customer_id = $1 AND outcome IN ('accepting', 'accepted') LIMIT 1`,
      [ctx.customerId],
    )
    if (accepted.length > 0)
      return null

    const { rows: reused } = await pg.query<OfferRow>(
      `UPDATE public.cancel_save_offers SET reason = $3, monthly_amount = $4, currency = $5
       WHERE id = (
         SELECT id FROM public.cancel_save_offers
         WHERE customer_id = $1 AND subscription_id = $2 AND outcome = 'offered'
           AND created_at > now() - make_interval(hours => $6::int)
         ORDER BY created_at DESC LIMIT 1
       )
       RETURNING id::text, subscription_id, monthly_amount, currency, percent_off, duration_months`,
      [ctx.customerId, subscriptionId, reason, saveable.amount, saveable.currency, OFFER_REUSE_HOURS],
    )
    if (reused[0])
      return toOffer(reused[0])

    const { rows } = await pg.query<OfferRow>(
      `INSERT INTO public.cancel_save_offers
         (org_id, customer_id, subscription_id, billing_account, reason, monthly_amount, currency, coupon_id, percent_off, duration_months)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id::text, subscription_id, monthly_amount, currency, percent_off, duration_months`,
      [orgId, ctx.customerId, subscriptionId, ctx.billingAccount, reason, saveable.amount, saveable.currency, CANCEL_SAVE_COUPON_ID, CANCEL_SAVE_OFFER_PERCENT_OFF, CANCEL_SAVE_OFFER_DURATION_MONTHS],
    )
    cloudlog({ requestId: c.get('requestId'), message: 'cancel save offer shown', customerId: ctx.customerId, subscriptionId, reason })
    return toOffer(rows[0])
  })
}

function discountFor(subscription: Stripe.Subscription) {
  for (const discount of subscription.discounts ?? []) {
    if (typeof discount === 'string')
      continue
    const coupon = discount.source?.coupon
    const couponId = typeof coupon === 'string' ? coupon : coupon?.id
    if (couponId === CANCEL_SAVE_COUPON_ID)
      return discount
  }
  return null
}

function addMonths(seconds: number, months: number) {
  const date = new Date(seconds * 1000)
  date.setUTCMonth(date.getUTCMonth() + months)
  return date.toISOString()
}

const UNIQUE_VIOLATION = '23505'

interface AcceptRow extends OfferRow {
  outcome: 'offered' | 'accepting' | 'accepted' | 'declined'
  discount_end: string | null
}

/**
 * Reserves the customer's one save before Stripe is touched: the partial unique
 * index on (customer_id) for accepting/accepted rejects a second reservation, even
 * from an older unanswered offer. Returns the offer in its current state.
 */
async function reserveOffer(c: Context, customerId: string, offerId: string): Promise<AcceptRow | null> {
  return await withPg(c, async (pg) => {
    const select = () => pg.query<AcceptRow>(
      `SELECT id::text, subscription_id, monthly_amount, currency, percent_off, duration_months, outcome,
         to_char(discount_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS discount_end
       FROM public.cancel_save_offers WHERE id = $1 AND customer_id = $2`,
      [offerId, customerId],
    )
    const row = (await select()).rows[0]
    if (row?.outcome !== 'offered')
      return row ?? null
    try {
      await pg.query(
        `UPDATE public.cancel_save_offers SET outcome = 'accepting', responded_at = now()
         WHERE id = $1 AND customer_id = $2 AND outcome = 'offered'`,
        [offerId, customerId],
      )
    }
    catch (error) {
      // The customer already took (or is taking) the discount with another offer.
      if ((error as { code?: unknown })?.code === UNIQUE_VIOLATION)
        return null
      throw error
    }
    // A concurrent request may have moved it on; report what is stored now.
    return (await select()).rows[0] ?? null
  })
}

async function releaseOffer(c: Context, customerId: string, offerId: string) {
  await withPg(c, pg => pg.query(
    `UPDATE public.cancel_save_offers SET outcome = 'offered', responded_at = NULL
     WHERE id = $1 AND customer_id = $2 AND outcome = 'accepting'`,
    [offerId, customerId],
  )).catch((error) => {
    cloudlogErr({ requestId: c.get('requestId'), message: 'cancel save offer release failed', customerId, error })
  })
}

async function applyDiscount(ctx: InAppBillingContext, subscriptionId: string, offerId: string) {
  const current = await retrieveSubscription(ctx, subscriptionId)
  // A retried accept finds the discount it already applied.
  if (discountFor(current))
    return current
  if (!getSaveableMonthlyAmount(current))
    throw simpleError('cancel_offer_unavailable', 'This offer is no longer available')
  await ensureCoupon(ctx.stripe)
  return await ctx.stripe.subscriptions.update(subscriptionId, {
    discounts: [{ coupon: CANCEL_SAVE_COUPON_ID }],
    expand: ['discounts'],
  }, { idempotencyKey: `cancel_save_offer:${offerId}` })
}

/** Applies the discount to the subscription; the plan keeps renewing. Safe to retry. */
export async function acceptCancelSaveOffer(c: Context, ctx: InAppBillingContext, offerId: string) {
  const offer = await reserveOffer(c, ctx.customerId, offerId)
  if (!offer || offer.outcome === 'offered' || offer.outcome === 'declined')
    throw simpleError('cancel_offer_unavailable', 'This offer is no longer available')
  // Already saved: a retry after a lost response returns the recorded result.
  if (offer.outcome === 'accepted' && offer.discount_end)
    return { discountEnd: offer.discount_end }

  const subscriptionId = await getActiveSubscriptionId(c, ctx.customerId)
  let discountStart: string
  let discountEnd: string
  try {
    if (offer.subscription_id !== subscriptionId)
      throw simpleError('cancel_offer_unavailable', 'This offer is no longer available')
    const discount = discountFor(await applyDiscount(ctx, subscriptionId, offerId))
    if (!discount)
      throw simpleError('cancel_offer_failed', 'The discount could not be applied')
    discountStart = new Date(discount.start * 1000).toISOString()
    discountEnd = discount.end ? new Date(discount.end * 1000).toISOString() : addMonths(discount.start, offer.duration_months)
  }
  catch (error) {
    // Nothing was applied: give the reservation back so the customer can try again.
    await releaseOffer(c, ctx.customerId, offerId)
    throw error
  }

  await withPg(c, pg => pg.query(
    `UPDATE public.cancel_save_offers
     SET outcome = 'accepted', discount_start = $3, discount_end = $4
     WHERE id = $1 AND customer_id = $2 AND outcome = 'accepting'`,
    [offerId, ctx.customerId, discountStart, discountEnd],
  ))
  cloudlog({ requestId: c.get('requestId'), message: 'cancel save offer accepted', customerId: ctx.customerId, subscriptionId, discountEnd })
  await syncSubscriptionData(c, ctx.customerId, subscriptionId)
  return { discountEnd }
}

/** Records that the customer canceled anyway. Never blocks the cancellation. */
export async function declineCancelSaveOffer(c: Context, ctx: InAppBillingContext, offerId: string) {
  try {
    await withPg(c, pg => pg.query(
      `UPDATE public.cancel_save_offers SET outcome = 'declined', responded_at = now()
       WHERE id = $1 AND customer_id = $2 AND outcome = 'offered'`,
      [offerId, ctx.customerId],
    ))
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'cancel save offer decline not recorded', customerId: ctx.customerId, error })
  }
}

export function parseOfferId(value: unknown) {
  if (typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value))
    return value
  return undefined
}
