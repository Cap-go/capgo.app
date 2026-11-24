import type { Context } from 'hono'
import type { CancelFeedback, InAppBillingContext } from './stripe_in_app.ts'
import Stripe from 'stripe'
import { simpleError } from './hono.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { closeClient, getPgClient, withPgTransaction } from './pg.ts'
import { getActiveSubscriptionId, lookupActiveSubscriptionId, syncSubscriptionData } from './stripe.ts'
import { scheduleSubscriptionCancel } from './stripe_in_app.ts'

// Cancel flow save offer. What a monthly customer who starts to cancel is offered
// depends on the reason they give:
// - 'credits' for customers who barely use Capgo ("unused", "other"): a discount on
//   a plan they do not need does not help, so they stop the monthly plan at period
//   end and get usage credits worth one month of it to keep shipping updates.
// - 'discount' for everyone else: a percent off the next months.
// Customers who already hold credits are offered nothing. Each offer and its outcome
// is stored in public.cancel_save_offers so the admin dashboard can chart saves over
// time and whether customers kept paying once the discount ended.

export type CancelSaveOfferType = 'discount' | 'credits'

export const CANCEL_SAVE_OFFER_PERCENT_OFF = 50
export const CANCEL_SAVE_OFFER_DURATION_MONTHS = 3
// Same id in both Stripe accounts; created on first use.
export const CANCEL_SAVE_COUPON_ID = `capgo_cancel_save_${CANCEL_SAVE_OFFER_PERCENT_OFF}_${CANCEL_SAVE_OFFER_DURATION_MONTHS}m`
// Reasons where using less, not paying less, is the problem.
const CREDITS_REASONS: readonly CancelFeedback[] = ['unused', 'other']
export const CANCEL_SAVE_CREDITS_EXPIRY_MONTHS = 12
// A reopened cancel dialog reuses the unanswered offer instead of counting a new one.
const OFFER_REUSE_HOURS = 24
// An accept that has not finished after this long failed without releasing its
// reservation (killed request): the subscription has no discount, so free it.
const STALE_ACCEPTING_MINUTES = 15

interface DiscountOffer {
  id: string
  type: 'discount'
  percentOff: number
  durationMonths: number
  monthlyAmount: number
  discountedAmount: number
  currency: string
}

interface CreditsOffer {
  id: string
  type: 'credits'
  credits: number
  monthlyAmount: number
  currency: string
}

export type CancelSaveOffer = DiscountOffer | CreditsOffer

interface OfferRow {
  id: string
  subscription_id: string
  reason: CancelFeedback
  offer_type: CancelSaveOfferType
  monthly_amount: string | number
  currency: string
  percent_off: number | null
  duration_months: number | null
  credits: string | number | null
}

const OFFER_COLUMNS = 'id::text, subscription_id, reason, offer_type, monthly_amount, currency, percent_off, duration_months, credits'

function toOffer(row: OfferRow): CancelSaveOffer {
  const monthlyAmount = Number(row.monthly_amount)
  if (row.offer_type === 'credits')
    return { id: row.id, type: 'credits', credits: Number(row.credits), monthlyAmount, currency: row.currency }
  const percentOff = row.percent_off ?? CANCEL_SAVE_OFFER_PERCENT_OFF
  return {
    id: row.id,
    type: 'discount',
    percentOff,
    durationMonths: row.duration_months ?? CANCEL_SAVE_OFFER_DURATION_MONTHS,
    monthlyAmount,
    discountedAmount: Math.round(monthlyAmount * (100 - percentOff) / 100),
    currency: row.currency,
  }
}

/**
 * Credits worth one month of the plan. One credit costs one US dollar, so this is
 * the plan's monthly list price in dollars (plans.price_m), whatever currency the
 * customer pays in. Null when the plan is unknown.
 */
export function creditsForPlanPrice(priceM: number | string | null | undefined): number | null {
  const credits = Math.ceil(Number(priceM))
  return Number.isFinite(credits) && credits > 0 ? credits : null
}

/** Which offer fits the reason, falling back to the discount when credits cannot be priced. */
export function offerTypeFor(reason: CancelFeedback, credits: number | null): CancelSaveOfferType {
  return CREDITS_REASONS.includes(reason) && credits !== null ? 'credits' : 'discount'
}

/** Stripe products of the plan items (not metered usage), to find the Capgo plan. */
export function planProductIds(subscription: Stripe.Subscription): string[] {
  return subscription.items.data
    .filter(item => item.price.recurring?.usage_type !== 'metered')
    .map(item => typeof item.price.product === 'string' ? item.price.product : item.price.product?.id)
    .filter((id): id is string => !!id)
}

/**
 * The monthly price the offer is based on, or null when the subscription cannot be
 * saved this way: not active, already ending, already discounted, or billed on
 * anything other than one month.
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

async function ensureCoupon(c: Context, stripe: Stripe) {
  try {
    await stripe.coupons.retrieve(CANCEL_SAVE_COUPON_ID)
    return
  }
  catch (error) {
    if (!(error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'resource_missing'))
      throw error
  }
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
    if (createError instanceof Stripe.errors.StripeInvalidRequestError && createError.code === 'resource_already_exists')
      return
    cloudlogErr({ requestId: c.get('requestId'), message: 'cancel save coupon create failed', error: createError })
    throw createError
  }
}

type PgClient = Awaited<ReturnType<typeof getPgClient>>

async function withPg<T>(c: Context, run: (pg: PgClient) => Promise<T>): Promise<T> {
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
  const subscription = await retrieveSubscription(ctx, subscriptionId)
  const saveable = getSaveableMonthlyAmount(subscription)
  if (!saveable)
    return null
  const products = planProductIds(subscription)

  return await withPg(c, async (pg) => {
    // Credits granted on this subscription while it still renews (saveable above:
    // active, not canceling) mean the switch never finished. Offer it again so
    // accepting completes the cancellation, without a second grant.
    const { rows: unfinished } = await pg.query<OfferRow>(
      `SELECT ${OFFER_COLUMNS} FROM public.cancel_save_offers
       WHERE customer_id = $1 AND subscription_id = $2 AND credit_grant_id IS NOT NULL
         AND outcome IN ('offered', 'accepting')
       ORDER BY created_at DESC LIMIT 1`,
      [ctx.customerId, subscriptionId],
    )
    if (unfinished[0])
      return toOffer(unfinished[0])

    // Credits already cover pay-as-you-go: neither offer adds anything.
    const { rows: org } = await pg.query<{ has_usage_credits: boolean | null }>(
      'SELECT has_usage_credits FROM public.orgs WHERE id = $1',
      [orgId],
    )
    if (org[0]?.has_usage_credits)
      return null

    let planCredits: number | null = null
    if (CREDITS_REASONS.includes(reason) && products.length > 0) {
      const { rows: plan } = await pg.query<{ price_m: string | number }>(
        'SELECT price_m FROM public.plans WHERE stripe_id = ANY($1::text[]) OR stripe_id_us = ANY($1::text[]) ORDER BY price_m DESC LIMIT 1',
        [products],
      )
      planCredits = creditsForPlanPrice(plan[0]?.price_m)
    }
    const offerType = offerTypeFor(reason, planCredits)
    const credits = offerType === 'credits' ? planCredits : null

    // The subscription has no discount (checked above), so an old reservation never
    // reached Stripe: give it back instead of blocking this customer forever.
    await pg.query(
      `UPDATE public.cancel_save_offers SET outcome = 'offered', responded_at = NULL
       WHERE customer_id = $1 AND outcome = 'accepting' AND discount_start IS NULL AND credit_grant_id IS NULL
         AND responded_at < now() - make_interval(mins => $2::int)`,
      [ctx.customerId, STALE_ACCEPTING_MINUTES],
    )

    const { rows: accepted } = await pg.query(
      `SELECT 1 FROM public.cancel_save_offers WHERE customer_id = $1 AND outcome IN ('accepting', 'accepted') LIMIT 1`,
      [ctx.customerId],
    )
    if (accepted.length > 0)
      return null

    const { rows: reused } = await pg.query<OfferRow>(
      `UPDATE public.cancel_save_offers SET reason = $3, monthly_amount = $4, currency = $5, credits = $8
       WHERE id = (
         SELECT id FROM public.cancel_save_offers
         WHERE customer_id = $1 AND subscription_id = $2 AND outcome = 'offered' AND offer_type = $7
           AND created_at > now() - make_interval(hours => $6::int)
         ORDER BY created_at DESC LIMIT 1
       )
         AND outcome = 'offered'
       RETURNING ${OFFER_COLUMNS}`,
      [ctx.customerId, subscriptionId, reason, saveable.amount, saveable.currency, OFFER_REUSE_HOURS, offerType, credits],
    )
    if (reused[0])
      return toOffer(reused[0])

    const discount = offerType === 'discount'
    const { rows } = await pg.query<OfferRow>(
      `INSERT INTO public.cancel_save_offers
         (org_id, customer_id, subscription_id, billing_account, reason, monthly_amount, currency, offer_type, coupon_id, percent_off, duration_months, credits)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${OFFER_COLUMNS}`,
      [
        orgId,
        ctx.customerId,
        subscriptionId,
        ctx.billingAccount,
        reason,
        saveable.amount,
        saveable.currency,
        offerType,
        discount ? CANCEL_SAVE_COUPON_ID : null,
        discount ? CANCEL_SAVE_OFFER_PERCENT_OFF : null,
        discount ? CANCEL_SAVE_OFFER_DURATION_MONTHS : null,
        credits,
      ],
    )
    cloudlog({ requestId: c.get('requestId'), message: 'cancel save offer shown', customerId: ctx.customerId, subscriptionId, reason, offerType })
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
  org_id: string
  outcome: 'offered' | 'accepting' | 'accepted' | 'declined'
  discount_end: string | null
  credit_grant_id: string | null
}

/**
 * Reserves the customer's one save before Stripe is touched: the partial unique
 * index on (customer_id) for accepting/accepted rejects a second reservation, even
 * from an older unanswered offer. Returns the offer in its current state.
 */
async function reserveOffer(c: Context, customerId: string, offerId: string): Promise<AcceptRow | null> {
  return await withPg(c, async (pg) => {
    const select = () => pg.query<AcceptRow>(
      `SELECT ${OFFER_COLUMNS}, org_id::text, outcome, credit_grant_id::text,
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
      // The customer already took (or is taking) a save with another offer.
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
    // Never once credits are granted: that save stays reserved until it completes.
    `UPDATE public.cancel_save_offers SET outcome = 'offered', responded_at = NULL
     WHERE id = $1 AND customer_id = $2 AND outcome = 'accepting' AND credit_grant_id IS NULL`,
    [offerId, customerId],
  )).catch((error) => {
    // prepareCancelSaveOffer frees it later once it is stale.
    cloudlogErr({ requestId: c.get('requestId'), message: 'cancel save offer release failed', customerId, offerId, error })
  })
}

async function applyDiscount(c: Context, ctx: InAppBillingContext, subscriptionId: string, offerId: string) {
  const current = await retrieveSubscription(ctx, subscriptionId)
  // A retried accept finds the discount it already applied.
  if (discountFor(current))
    return current
  if (!getSaveableMonthlyAmount(current))
    throw simpleError('cancel_offer_unavailable', 'This offer is no longer available')
  await ensureCoupon(c, ctx.stripe)
  return await ctx.stripe.subscriptions.update(subscriptionId, {
    discounts: [{ coupon: CANCEL_SAVE_COUPON_ID }],
    expand: ['discounts'],
  }, { idempotencyKey: `cancel_save_offer:${offerId}` })
}

async function acceptDiscount(c: Context, ctx: InAppBillingContext, offer: AcceptRow): Promise<{ discountEnd: string }> {
  const subscriptionId = offer.subscription_id
  let discount: Stripe.Discount | null
  try {
    discount = discountFor(await applyDiscount(c, ctx, subscriptionId, offer.id))
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'cancel save discount failed', customerId: ctx.customerId, offerId: offer.id, error })
    // An earlier attempt, or this failed call, may have applied the discount: look before releasing.
    const after = await retrieveSubscription(ctx, subscriptionId).then(subscription => discountFor(subscription)).catch(() => undefined)
    // Stripe unreadable: keep the reservation, a retry (or the stale cleanup) reconciles it.
    if (after === undefined)
      throw error
    if (!after) {
      await releaseOffer(c, ctx.customerId, offer.id)
      throw error
    }
    discount = after
  }
  if (!discount) {
    await releaseOffer(c, ctx.customerId, offer.id)
    throw simpleError('cancel_offer_failed', 'The discount could not be applied')
  }
  const discountStart = new Date(discount.start * 1000).toISOString()
  const discountEnd = discount.end ? new Date(discount.end * 1000).toISOString() : addMonths(discount.start, offer.duration_months ?? CANCEL_SAVE_OFFER_DURATION_MONTHS)

  // The discount is on the subscription, so record it even if a concurrent attempt on
  // this offer failed and released the reservation in the meantime.
  const { rowCount } = await withPg(c, pg => pg.query(
    `UPDATE public.cancel_save_offers
     SET outcome = 'accepted', responded_at = COALESCE(responded_at, now()), discount_start = $3, discount_end = $4
     WHERE id = $1 AND customer_id = $2 AND outcome IN ('offered', 'accepting', 'accepted')`,
    [offer.id, ctx.customerId, discountStart, discountEnd],
  ))
  if (!rowCount)
    cloudlogErr({ requestId: c.get('requestId'), message: 'cancel save offer applied but not recorded', customerId: ctx.customerId, offerId: offer.id })
  cloudlog({ requestId: c.get('requestId'), message: 'cancel save offer accepted', customerId: ctx.customerId, subscriptionId, discountEnd })
  await syncSubscriptionData(c, ctx.customerId, subscriptionId)
  return { discountEnd }
}

/**
 * Grants the offer's credits once: the grant id is stored on the offer row in the
 * same transaction, so a retried accept never grants twice.
 */
async function grantOfferCredits(c: Context, offer: AcceptRow) {
  return await withPg(c, pg => withPgTransaction(pg, async (tx) => {
    const { rows } = await tx.query<{ credit_grant_id: string | null, outcome: string }>(
      'SELECT credit_grant_id::text, outcome FROM public.cancel_save_offers WHERE id = $1 FOR UPDATE',
      [offer.id],
    )
    const existing = rows[0]?.credit_grant_id
    if (existing)
      return existing
    // Grant only while this accept still holds the customer's one save: a concurrent
    // cancel may have declined or released the offer since it was reserved.
    if (rows[0]?.outcome !== 'accepting')
      throw simpleError('cancel_offer_unavailable', 'This offer is no longer available')
    const notes = 'Cancel flow: credits instead of the monthly plan'
    const sourceRef = JSON.stringify({ cancelSaveOfferId: offer.id })
    const { rows: grant } = await tx.query<{ id: string }>(
      `INSERT INTO public.usage_credit_grants (org_id, credits_total, credits_consumed, granted_at, expires_at, source, source_ref, notes)
       VALUES ($1, $2, 0, now(), now() + make_interval(months => $3::int), 'cancel_save_offer', $4::jsonb, $5)
       RETURNING id::text`,
      [offer.org_id, offer.credits, CANCEL_SAVE_CREDITS_EXPIRY_MONTHS, sourceRef, notes],
    )
    const grantId = grant[0].id
    await tx.query(
      `INSERT INTO public.usage_credit_transactions (org_id, grant_id, transaction_type, amount, balance_after, description, source_ref)
       SELECT $1, $2, 'manual_grant', $3,
         COALESCE((SELECT available_credits FROM public.usage_credit_balances WHERE org_id = $1), 0),
         $4, $5::jsonb`,
      [offer.org_id, grantId, offer.credits, notes, sourceRef],
    )
    await tx.query('UPDATE public.cancel_save_offers SET credit_grant_id = $2 WHERE id = $1', [offer.id, grantId])
    return grantId
  }))
}

async function acceptCredits(c: Context, ctx: InAppBillingContext, offer: AcceptRow, comment?: string): Promise<{ credits: number }> {
  const credits = Number(offer.credits)
  try {
    // A first grant needs the subscription to still qualify, as when the offer was
    // shown (active, not ending, monthly, no discount). A grant-backed retry only
    // finishes the cancellation, so it skips this check.
    if (!offer.credit_grant_id && !getSaveableMonthlyAmount(await retrieveSubscription(ctx, offer.subscription_id)))
      throw simpleError('cancel_offer_unavailable', 'This offer is no longer available')
    await grantOfferCredits(c, offer)
    // The monthly plan stops at period end; the credits take over from there.
    await scheduleSubscriptionCancel(c, ctx, offer.reason, comment, offer.subscription_id)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'cancel save credits failed', customerId: ctx.customerId, offerId: offer.id, error })
    // Once the credits are granted the offer keeps the customer's one save
    // reserved: a retry finishes the cancellation without granting again, and no
    // other offer can grant a second time.
    // releaseOffer keeps the reservation once a grant exists.
    await releaseOffer(c, ctx.customerId, offer.id)
    throw error
  }
  await withPg(c, pg => pg.query(
    `UPDATE public.cancel_save_offers SET outcome = 'accepted', responded_at = COALESCE(responded_at, now())
     WHERE id = $1 AND customer_id = $2 AND credit_grant_id IS NOT NULL`,
    [offer.id, ctx.customerId],
  ))
  cloudlog({ requestId: c.get('requestId'), message: 'cancel save credits accepted', customerId: ctx.customerId, offerId: offer.id, credits })
  return { credits }
}

export type AcceptCancelSaveOfferResult
  = | { type: 'discount', discountEnd: string }
    | { type: 'credits', credits: number }

/** Applies the offer: a discount keeps the plan, credits replace it at period end. Safe to retry. */
export async function acceptCancelSaveOffer(c: Context, ctx: InAppBillingContext, offerId: string, comment?: string): Promise<AcceptCancelSaveOfferResult> {
  const offer = await reserveOffer(c, ctx.customerId, offerId)
  if (!offer || offer.outcome === 'offered' || offer.outcome === 'declined')
    throw simpleError('cancel_offer_unavailable', 'This offer is no longer available')
  // Already saved: a retry after a lost response returns the recorded result. A
  // credits offer is written 'accepted' only once its cancellation is scheduled, so
  // nothing is left to do (and a plan resumed since must not be canceled again). An
  // 'accepting' offer that already holds a grant goes on to finish its cancellation.
  if (offer.outcome === 'accepted' && offer.offer_type === 'credits')
    return { type: 'credits', credits: Number(offer.credits) }
  if (offer.outcome === 'accepted' && offer.offer_type === 'discount' && offer.discount_end)
    return { type: 'discount', discountEnd: offer.discount_end }

  let activeSubscriptionId: string | null
  try {
    const lookup = await lookupActiveSubscriptionId(c, ctx.customerId)
    if (!lookup.known)
      throw simpleError('cancel_offer_failed', 'The offer could not be applied')
    activeSubscriptionId = lookup.subscriptionId
  }
  catch (error) {
    // Nothing reached Stripe yet: let the customer try again.
    await releaseOffer(c, ctx.customerId, offerId)
    throw error
  }
  if (activeSubscriptionId !== offer.subscription_id) {
    await releaseOffer(c, ctx.customerId, offerId)
    throw simpleError('cancel_offer_unavailable', 'This offer is no longer available')
  }

  if (offer.offer_type === 'credits')
    return { type: 'credits', ...await acceptCredits(c, ctx, offer, comment) }
  return { type: 'discount', ...await acceptDiscount(c, ctx, offer) }
}

/**
 * Records that the customer canceled anyway. Never blocks the cancellation. An
 * offer left 'accepting' by a failed accept, with nothing applied, counts as declined.
 * An offer whose credits were already granted is left alone: see completeCreditsOfferAfterCancel.
 */
export async function declineCancelSaveOffer(c: Context, ctx: InAppBillingContext, offerId: string) {
  try {
    await withPg(c, pg => pg.query(
      `UPDATE public.cancel_save_offers SET outcome = 'declined', responded_at = COALESCE(responded_at, now())
       WHERE id = $1 AND customer_id = $2 AND credit_grant_id IS NULL
         AND (outcome = 'offered' OR (outcome = 'accepting' AND discount_start IS NULL))`,
      [offerId, ctx.customerId],
    ))
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'cancel save offer decline not recorded', customerId: ctx.customerId, error })
  }
}

/**
 * Called once a plain cancel has been scheduled: credits granted by an accept that
 * failed before canceling now have their switch completed, so the offer is accepted.
 */
export async function completeCreditsOfferAfterCancel(c: Context, ctx: InAppBillingContext, offerId: string) {
  try {
    await withPg(c, pg => pg.query(
      `UPDATE public.cancel_save_offers SET outcome = 'accepted', responded_at = COALESCE(responded_at, now())
       WHERE id = $1 AND customer_id = $2 AND credit_grant_id IS NOT NULL AND outcome IN ('offered', 'accepting')`,
      [offerId, ctx.customerId],
    ))
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'cancel save credits completion not recorded', customerId: ctx.customerId, offerId, error })
  }
}

export function parseOfferId(value: unknown) {
  if (typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value))
    return value
  return undefined
}
