import type { Context } from 'hono'
import type Stripe from 'stripe'
import type { InAppBillingContext } from './stripe_in_app.ts'
import { stripeAmountToMajorUnits } from '../../shared/stripe-amount.ts'
import { syncBentoSubscriberTags, trackBentoEvent } from './bento.ts'
import { TRIAL_CARD_BENTO_TAG } from './billing_bento_tags.ts'
import { simpleError } from './hono.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { checkoutPgClient, closeClient, getPgClient, releasePgClient, TRANSACTION_IDLE_TIMEOUT_MS } from './pg.ts'
import type { BillingAccount } from './stripe_billing.ts'
import type { PriceTier } from './country_price_tier.ts'
import { getCustomerBilling, priceTierForCurrency } from './regional_price.ts'
import { findPlanByProductId, getPlanPriceId, getPlanProductId, getRegionalPlanPriceId, getRequestCountry, isAutomaticTaxEnabled, TRIAL_PLAN_SCHEDULE_METADATA_KEY } from './stripe_billing.ts'
import { supabaseAdmin } from './supabase.ts'

// Starts the plan picked during onboarding when the free trial ends, charging the saved card.
// A subscription schedule creates no subscription until its start date, so the org stays a
// trial org (no paying flag, revenue or "subscribed" emails) until Stripe actually bills it.

export const TRIAL_CARD_ADDED_BENTO_EVENT = 'org:trial_card_added'
export const TRIAL_PLAN_CANCELED_BENTO_EVENT = 'org:trial_plan_canceled'
export const TRIAL_PLAN_STARTED_NOW_BENTO_EVENT = 'org:trial_plan_started_now'

// Marks a trial plan subscription the user started before the trial ended ("Start now").
// It also carries TRIAL_PLAN_SCHEDULE_METADATA_KEY so the webhook converts it like a
// schedule-born trial plan once its first invoice is paid.
export const TRIAL_PLAN_STARTED_NOW_METADATA_KEY = 'capgo_trial_started_now'

// Fixed monthly plans that can auto-start when the trial ends. Enterprise needs a custom MAU quote.
export const SCHEDULABLE_TRIAL_PLAN_NAMES = ['Solo', 'Maker', 'Team'] as const

export interface TrialPlanSummary {
  planName: string
  // Stripe product id for this billing account; used when the user switches plan before scheduling.
  productId: string
  amount: number
  currency: string
  interval: 'month'
  // When the plan starts and the first invoice is charged.
  startsAt: string
  scheduled: boolean
}

// Plans the user can pick in the card/prompt flow (default = onboarding product).
export interface TrialPlanOption {
  productId: string
  planName: string
  // Monthly list price in the smallest currency unit (same as Stripe unit_amount).
  amount: number
  currency: string
  // Full price when a regional discount applies, for the strike-through.
  regularAmount?: number
}

export interface TrialPlanAttribution {
  affonsoReferral?: string | null
  datafastVisitorId?: string | null
  datafastSessionId?: string | null
}

interface TrialState {
  planName: string
  productId: string
  priceId: string
  startsAt: Date
}

// The plugin gate allows trial traffic while trial_at::date > CURRENT_DATE (UTC), so access
// ends at 00:00 UTC on the trial_at date: start the plan exactly then.
export function getTrialPlanStartDate(trialAt: string | null | undefined, now = Date.now()): Date | null {
  if (!trialAt)
    return null
  const parsed = new Date(trialAt)
  if (Number.isNaN(parsed.getTime()))
    return null
  const start = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()))
  return start.getTime() > now ? start : null
}

type TrialPlanPriceRow = Parameters<typeof getPlanPriceId>[0] & { regional_price_ids?: unknown }

// Same monthly price as checkout: plans with regional prices (Solo) charge the tier of the most expensive
// of the visitor, billing address and saved card countries (the card the trial will charge).
export function getTrialPlanPriceId(plan: TrialPlanPriceRow, billingAccount: BillingAccount, tier: PriceTier): string {
  return getRegionalPlanPriceId(plan.regional_price_ids, tier, billingAccount, 'month') ?? getPlanPriceId(plan, billingAccount, 'month')
}

// The schedule bills in the customer's Stripe currency, USD until one is pinned: a regional price needs it
// to be the region's currency.
async function getTrialPriceTier(c: Context, ctx: InAppBillingContext): Promise<PriceTier> {
  const { countries, currency } = await getCustomerBilling(ctx.stripe, ctx.customerId)
  return priceTierForCurrency([getRequestCountry(c), ...countries], currency ?? 'usd', null)
}

async function loadTrialState(c: Context, ctx: InAppBillingContext): Promise<TrialState | null> {
  const { data: info, error } = await supabaseAdmin(c)
    .from('stripe_info')
    .select('product_id, trial_at, status, subscription_id')
    .eq('customer_id', ctx.customerId)
    .maybeSingle()
  if (error)
    throw error
  // Orgs that already subscribed manage their plan through checkout, not this flow. A linked
  // subscription counts even when a failed charge left the status at failed.
  const hasLiveSubscription = !!info?.subscription_id && info.status !== 'canceled' && info.status !== 'deleted'
  if (!info?.product_id || info.status === 'succeeded' || hasLiveSubscription)
    return null
  const startsAt = getTrialPlanStartDate(info.trial_at)
  if (!startsAt)
    return null
  const { data: plan } = await findPlanByProductId(c, info.product_id)
  if (!plan)
    return null
  // Outside the try: a Stripe failure must be retried, not read as a missing trial plan.
  const tier = await getTrialPriceTier(c, ctx)
  let priceId: string
  let productId: string
  try {
    priceId = getTrialPlanPriceId(plan, ctx.billingAccount, tier)
    productId = getPlanProductId(plan, ctx.billingAccount)
  }
  catch {
    return null
  }
  if (!priceId || !productId)
    return null
  return { planName: plan.name, productId, priceId, startsAt }
}

function isSchedulableTrialPlanName(name: string | null | undefined): boolean {
  return !!name && (SCHEDULABLE_TRIAL_PLAN_NAMES as readonly string[]).includes(name)
}

// Monthly Solo/Maker/Team for the org's billing account so the prompt can switch before scheduling.
export async function listSchedulableTrialPlans(c: Context, ctx: InAppBillingContext): Promise<TrialPlanOption[]> {
  const { billingAccount } = ctx
  const [{ data: plans, error }, tier] = await Promise.all([
    supabaseAdmin(c)
      .from('plans')
      .select('name, price_m, stripe_id, price_m_id, price_y_id, stripe_id_us, price_m_id_us, price_y_id_us, regional_price_ids')
      .in('name', [...SCHEDULABLE_TRIAL_PLAN_NAMES]),
    getTrialPriceTier(c, ctx),
  ])
  if (error)
    throw error
  // Console Plans page lists these in USD; keep the picker consistent.
  const options = await Promise.all((plans ?? []).map(async (plan): Promise<TrialPlanOption | null> => {
    try {
      const productId = getPlanProductId(plan, billingAccount)
      if (!productId || !isSchedulableTrialPlanName(plan.name))
        return null
      // A regional discount shows the USD amount of the price the schedule will charge.
      const regionalPriceId = getRegionalPlanPriceId(plan.regional_price_ids, tier, billingAccount, 'month')
      // plans.price_m is a major-unit monthly list price (e.g. 14 for Solo).
      const regularAmount = Math.round(Number(plan.price_m) * 100)
      const amount = regionalPriceId ? (await ctx.stripe.prices.retrieve(regionalPriceId)).unit_amount ?? regularAmount : regularAmount
      if (!Number.isFinite(amount) || amount <= 0)
        return null
      return { productId, planName: plan.name!, amount, currency: 'usd', ...(amount < regularAmount ? { regularAmount } : {}) }
    }
    catch {
      return null
    }
  }))
  return options.filter((option): option is TrialPlanOption => !!option).sort((a, b) => a.amount - b.amount)
}

// Persist a different onboarding product before scheduling so Billing and the schedule agree.
async function applyTrialPlanProduct(c: Context, ctx: InAppBillingContext, productId: string | undefined): Promise<TrialState | null> {
  const state = await loadTrialState(c, ctx)
  if (!state)
    return null
  if (!productId || productId === state.productId)
    return state
  const { data: plan } = await findPlanByProductId(c, productId)
  if (!plan || !isSchedulableTrialPlanName(plan.name))
    throw simpleError('invalid_trial_plan', 'This plan cannot start automatically when the trial ends')
  // Outside the try: a Stripe failure must be retried, not reported as an invalid plan.
  const tier = await getTrialPriceTier(c, ctx)
  let nextProductId: string
  let priceId: string
  try {
    nextProductId = getPlanProductId(plan, ctx.billingAccount)
    priceId = getTrialPlanPriceId(plan, ctx.billingAccount, tier)
  }
  catch {
    throw simpleError('invalid_trial_plan', 'This plan cannot start automatically when the trial ends')
  }
  if (nextProductId !== productId)
    throw simpleError('invalid_trial_plan', 'This plan cannot start automatically when the trial ends')
  const { error } = await supabaseAdmin(c)
    .from('stripe_info')
    .update({ product_id: nextProductId })
    .eq('customer_id', ctx.customerId)
  if (error)
    throw error
  return { planName: plan.name!, productId: nextProductId, priceId, startsAt: state.startsAt }
}

async function listPendingTrialPlanSchedules(stripe: Stripe, customerId: string) {
  // Read every page so cancellation is exhaustive.
  const all: Stripe.SubscriptionSchedule[] = []
  let startingAfter: string | undefined
  do {
    const page = await stripe.subscriptionSchedules.list({ customer: customerId, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) })
    all.push(...page.data)
    startingAfter = page.has_more ? page.data.at(-1)?.id : undefined
  } while (startingAfter)
  return all
    .filter(schedule => schedule.status === 'not_started' && schedule.metadata?.[TRIAL_PLAN_SCHEDULE_METADATA_KEY] === 'true')
    .sort((a, b) => a.created - b.created)
}

export async function findPendingTrialPlanSchedule(stripe: Stripe, customerId: string) {
  return (await listPendingTrialPlanSchedules(stripe, customerId))[0] ?? null
}

async function cancelSchedules(c: Context, stripe: Stripe, customerId: string, schedules: readonly Stripe.SubscriptionSchedule[], message: string) {
  await Promise.all(schedules.map(async (schedule) => {
    await stripe.subscriptionSchedules.cancel(schedule.id)
    cloudlog({ requestId: c.get('requestId'), message, customerId, scheduleId: schedule.id })
  }))
}

// Keep the oldest pending schedule; concurrent requests may each have created one.
export async function cancelDuplicateTrialPlanSchedules(c: Context, stripe: Stripe, customerId: string) {
  const [, ...duplicates] = await listPendingTrialPlanSchedules(stripe, customerId)
  await cancelSchedules(c, stripe, customerId, duplicates, 'duplicate trial plan schedule canceled')
}

// Cancel every pending trial plan schedule, duplicates included, so none can still charge.
async function cancelAllPendingTrialPlanSchedules(c: Context, stripe: Stripe, customerId: string, message: string) {
  const schedules = await listPendingTrialPlanSchedules(stripe, customerId)
  await cancelSchedules(c, stripe, customerId, schedules, message)
  return schedules.length
}

async function cancelPendingTrialPlanSchedulesExcept(
  c: Context,
  stripe: Stripe,
  customerId: string,
  keepScheduleId: string,
  message: string,
) {
  const schedules = (await listPendingTrialPlanSchedules(stripe, customerId))
    .filter(schedule => schedule.id !== keepScheduleId)
  await cancelSchedules(c, stripe, customerId, schedules, message)
  return schedules.length
}

// Describes the pending schedule as Stripe will bill it, whether or not the org would be
// eligible to schedule a new one, so Billing always shows (and can cancel) a pending charge.
async function summarizePendingSchedule(c: Context, ctx: InAppBillingContext, schedule: Stripe.SubscriptionSchedule): Promise<TrialPlanSummary | null> {
  const phase = schedule.phases[0]
  const scheduledPrice = phase?.items[0]?.price
  const priceId = typeof scheduledPrice === 'string' ? scheduledPrice : scheduledPrice?.id
  if (!phase || !priceId)
    return null
  const price = await ctx.stripe.prices.retrieve(priceId)
  const productId = typeof price.product === 'string' ? price.product : price.product.id
  const { data: plan } = await findPlanByProductId(c, productId)
  return {
    planName: plan?.name ?? '',
    productId,
    amount: price.unit_amount ?? 0,
    currency: price.currency,
    interval: 'month',
    startsAt: new Date(phase.start_date * 1000).toISOString(),
    scheduled: true,
  }
}

export async function getTrialPlanSummary(c: Context, ctx: InAppBillingContext): Promise<TrialPlanSummary | null> {
  const schedule = await findPendingTrialPlanSchedule(ctx.stripe, ctx.customerId)
  if (schedule)
    return summarizePendingSchedule(c, ctx, schedule)
  // Eligibility only gates offering a new plan.
  const state = await loadTrialState(c, ctx)
  if (!state)
    return null
  const price = await ctx.stripe.prices.retrieve(state.priceId)
  return {
    planName: state.planName,
    productId: state.productId,
    amount: price.unit_amount ?? 0,
    currency: price.currency,
    interval: 'month',
    startsAt: state.startsAt.toISOString(),
    scheduled: false,
  }
}

function attributionMetadata(attribution: TrialPlanAttribution): Record<string, string> {
  const metadata: Record<string, string> = {}
  const add = (key: string, value: string | null | undefined) => {
    if (typeof value === 'string' && value && value.length <= 500)
      metadata[key] = value
  }
  add('affonso_referral', attribution.affonsoReferral)
  add('datafast_visitor_id', attribution.datafastVisitorId)
  add('datafast_session_id', attribution.datafastSessionId)
  return metadata
}

// Stripe Tax needs a customer location; the card form only fills the payment method's
// billing address, so copy it to the customer when the customer has none.
async function ensureCustomerTaxAddress(ctx: InAppBillingContext) {
  const customer = await ctx.stripe.customers.retrieve(ctx.customerId, { expand: ['invoice_settings.default_payment_method'] })
  if (customer.deleted || customer.address?.country)
    return
  const paymentMethod = customer.invoice_settings?.default_payment_method
  const address = paymentMethod && typeof paymentMethod === 'object' ? paymentMethod.billing_details?.address : null
  if (!address?.country)
    return
  await ctx.stripe.customers.update(ctx.customerId, {
    address: {
      country: address.country,
      ...(address.postal_code ? { postal_code: address.postal_code } : {}),
      ...(address.line1 ? { line1: address.line1 } : {}),
      ...(address.line2 ? { line2: address.line2 } : {}),
      ...(address.city ? { city: address.city } : {}),
      ...(address.state ? { state: address.state } : {}),
    },
  })
}

// Older customers can have a card attached without a default; the schedule charges the
// default, so promote that card instead of failing.
async function ensureDefaultPaymentMethod(ctx: InAppBillingContext) {
  const customer = await ctx.stripe.customers.retrieve(ctx.customerId)
  if (customer.deleted)
    return false
  if (customer.invoice_settings?.default_payment_method)
    return true
  const cards = await ctx.stripe.paymentMethods.list({ customer: ctx.customerId, type: 'card', limit: 1 })
  const card = cards.data[0]
  if (!card)
    return false
  await ctx.stripe.customers.update(ctx.customerId, { invoice_settings: { default_payment_method: card.id } })
  return true
}

async function getTrialPlanBentoEmails(c: Context, orgId: string, userId: string | undefined) {
  const admin = supabaseAdmin(c)
  const [{ data: org }, { data: user }] = await Promise.all([
    admin.from('orgs').select('management_email').eq('id', orgId).maybeSingle(),
    userId ? admin.from('users').select('email').eq('id', userId).maybeSingle() : Promise.resolve({ data: null }),
  ])
  return Array.from(new Set([org?.management_email, user?.email]
    .filter((email): email is string => typeof email === 'string' && email.trim().length > 0)
    .map(email => email.trim().toLowerCase())))
}

type TrialPlanBentoChange = 'scheduled' | 'canceled' | 'started_now'

async function notifyBento(c: Context, orgId: string, userId: string | undefined, change: TrialPlanBentoChange, summary: TrialPlanSummary) {
  try {
    const emails = await getTrialPlanBentoEmails(c, orgId, userId)
    const tags = change === 'scheduled'
      ? { segments: [TRIAL_CARD_BENTO_TAG], deleteSegments: [] }
      : { segments: [], deleteSegments: [TRIAL_CARD_BENTO_TAG] }
    const event = {
      scheduled: TRIAL_CARD_ADDED_BENTO_EVENT,
      canceled: TRIAL_PLAN_CANCELED_BENTO_EVENT,
      started_now: TRIAL_PLAN_STARTED_NOW_BENTO_EVENT,
    }[change]
    const data = {
      org_id: orgId,
      plan_name: summary.planName,
      amount: stripeAmountToMajorUnits(summary.amount, summary.currency),
      currency: summary.currency,
      starts_at: summary.startsAt,
    }
    await syncBentoSubscriberTags(c, emails.map(email => ({ email, ...tags })))
    await Promise.all(emails.map(email => trackBentoEvent(c, email, data, event)))
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'trial plan bento sync failed', orgId, change, error })
  }
}

export async function scheduleTrialPlan(
  c: Context,
  ctx: InAppBillingContext,
  orgId: string,
  attribution: TrialPlanAttribution = {},
  productId?: string,
) {
  const state = await applyTrialPlanProduct(c, ctx, productId)
  if (!state)
    throw simpleError('trial_plan_unavailable', 'This organization is not on a free trial')
  if (!await ensureDefaultPaymentMethod(ctx))
    throw simpleError('missing_payment_method', 'Add a card before starting the plan')

  // Same lock as Start now: a schedule created next to a started-now subscription would
  // charge the org a second time when the trial ends.
  const notifiedNewSchedule = await withTrialPlanLock(c, ctx.customerId, async () => {
    if (await findLiveSubscription(ctx.stripe, ctx.customerId))
      throw simpleError('trial_plan_already_subscribed', 'This organization already has a subscription')
    const existing = await findPendingTrialPlanSchedule(ctx.stripe, ctx.customerId)
    const existingPrice = existing?.phases[0]?.items[0]?.price
    const existingPriceId = typeof existingPrice === 'string' ? existingPrice : existingPrice?.id
    const needsReplacement = !!existing && !!existingPriceId && existingPriceId !== state.priceId
    const createsSchedule = !existing || needsReplacement
    if (createsSchedule) {
      await ensureCustomerTaxAddress(ctx)
      const metadata = attributionMetadata(attribution)
      if (Object.keys(metadata).length)
        await ctx.stripe.customers.update(ctx.customerId, { metadata })
      // Create the replacement before canceling any pending schedule so a Stripe failure
      // leaves the previously confirmed automatic start intact.
      const schedule = await ctx.stripe.subscriptionSchedules.create({
        customer: ctx.customerId,
        start_date: Math.floor(state.startsAt.getTime() / 1000),
        end_behavior: 'release',
        default_settings: {
          automatic_tax: { enabled: isAutomaticTaxEnabled(ctx.billingAccount) },
          collection_method: 'charge_automatically',
        },
        // Phase metadata lands on the subscription so the webhook can recognize it.
        phases: [{ items: [{ price: state.priceId, quantity: 1 }], metadata: { ...metadata, org_id: orgId, [TRIAL_PLAN_SCHEDULE_METADATA_KEY]: 'true' } }],
        metadata: { [TRIAL_PLAN_SCHEDULE_METADATA_KEY]: 'true', org_id: orgId },
      })
      cloudlog({ requestId: c.get('requestId'), message: 'trial plan scheduled', orgId, scheduleId: schedule.id, startsAt: state.startsAt.toISOString(), productId: state.productId })
      if (needsReplacement) {
        await cancelPendingTrialPlanSchedulesExcept(
          c,
          ctx.stripe,
          ctx.customerId,
          schedule.id,
          'trial plan schedule replaced by plan change',
        )
      }
    }
    // No idempotency key (it would replay a canceled schedule): drop duplicates from concurrent
    // submits instead, on every call so a retry repairs a cleanup that failed earlier.
    await cancelDuplicateTrialPlanSchedules(c, ctx.stripe, ctx.customerId)
    return createsSchedule
  })

  const summary = await getTrialPlanSummary(c, ctx)
  if (!summary)
    throw simpleError('trial_plan_unavailable', 'This organization is not on a free trial')
  if (notifiedNewSchedule)
    await notifyBento(c, orgId, c.get('auth')?.userId, 'scheduled', summary)
  return summary
}

export interface StartNowSubscriptionInput {
  customerId: string
  orgId: string
  priceId: string
  paymentMethodId: string
  automaticTax: boolean
  metadata: Record<string, string>
}

// Statuses that mean the customer already has a subscription Stripe bills or may still bill.
const LIVE_SUBSCRIPTION_STATUSES = new Set<Stripe.Subscription.Status>(['active', 'trialing', 'past_due', 'unpaid', 'incomplete'])

// The webhook updates stripe_info only after the fact, so ask Stripe directly.
async function findLiveSubscription(stripe: Stripe, customerId: string) {
  const page = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })
  return page.data.find(subscription => LIVE_SUBSCRIPTION_STATUSES.has(subscription.status)) ?? null
}

// Charges the first month right away. error_if_incomplete makes Stripe reject the request
// (no subscription is left behind) when the card is declined or needs authentication.
// Callers hold the per-customer trial plan lock: an existing live subscription is reused when
// it is a started-now plan (a retry after a lost response) and refused otherwise, so two
// requests, other cards or other attribution cookies can never charge twice. No explicit
// idempotency key: Stripe would replay a declined card for 24 hours, so a fixed card could
// never be retried (stripe-node still adds one to its own network retries).
export async function createStartNowSubscription(stripe: Stripe, input: StartNowSubscriptionInput): Promise<{ subscription: Stripe.Subscription, reused: boolean }> {
  const live = await findLiveSubscription(stripe, input.customerId)
  if (live) {
    if (isTrialPlanStartedNow(live))
      return { subscription: live, reused: true }
    throw simpleError('trial_plan_already_subscribed', 'This organization already has a subscription')
  }
  const metadata = {
    ...input.metadata,
    org_id: input.orgId,
    [TRIAL_PLAN_SCHEDULE_METADATA_KEY]: 'true',
    [TRIAL_PLAN_STARTED_NOW_METADATA_KEY]: 'true',
  }
  const params: Stripe.SubscriptionCreateParams = {
    customer: input.customerId,
    items: [{ price: input.priceId, quantity: 1 }],
    default_payment_method: input.paymentMethodId,
    collection_method: 'charge_automatically',
    payment_behavior: 'error_if_incomplete',
    automatic_tax: { enabled: input.automaticTax },
    metadata,
  }
  try {
    return { subscription: await stripe.subscriptions.create(params), reused: false }
  }
  catch (error) {
    const stripeError = error as { type?: string, statusCode?: number, code?: string }
    if (stripeError.type === 'StripeCardError' || stripeError.statusCode === 402)
      throw simpleError('trial_plan_payment_failed', 'The card could not be charged', { code: stripeError.code })
    throw error
  }
}

export function isTrialPlanStartedNow(subscription: Pick<Stripe.Subscription, 'metadata'>) {
  return subscription.metadata?.[TRIAL_PLAN_STARTED_NOW_METADATA_KEY] === 'true'
}

interface LockQueryClient { query: (queryText: string, values?: unknown[]) => Promise<unknown> }

// Holds a transaction-scoped advisory lock on `client` while `run` calls Stripe. `run` never
// uses the connection, so a heartbeat keeps the transaction from going idle: otherwise
// idle_in_transaction_session_timeout would end the session and release the lock mid-charge.
// The timeout stays set so a request that dies without its heartbeat frees the lock.
// The lock guards no writes, so a failed heartbeat or COMMIT after `run` succeeded is logged
// and the Stripe result is still returned.
export async function holdTrialPlanLock<T>(
  c: Context,
  client: LockQueryClient,
  customerId: string,
  run: () => Promise<T>,
  heartbeatMs = Math.floor(TRANSACTION_IDLE_TIMEOUT_MS / 3),
): Promise<{ result: T, connectionLost: boolean }> {
  await client.query(`BEGIN READ WRITE; SET LOCAL statement_timeout = 10000; SET LOCAL idle_in_transaction_session_timeout = ${TRANSACTION_IDLE_TIMEOUT_MS}`)
  let connectionLost = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  try {
    await client.query('SELECT pg_catalog.pg_advisory_xact_lock(hashtextextended($1, 0))', [`trial_plan:${customerId}`])
    heartbeat = setInterval(() => {
      client.query('SELECT 1').catch((error) => {
        connectionLost = true
        clearInterval(heartbeat)
        cloudlogErr({ requestId: c.get('requestId'), message: 'trial plan lock heartbeat failed', customerId, error })
      })
    }, heartbeatMs)
    const result = await run()
    clearInterval(heartbeat)
    try {
      await client.query('COMMIT')
    }
    catch (error) {
      connectionLost = true
      cloudlogErr({ requestId: c.get('requestId'), message: 'trial plan lock commit failed', customerId, error })
    }
    return { result, connectionLost }
  }
  catch (error) {
    clearInterval(heartbeat)
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}

// Serializes every trial plan charge (Start now and the trial-end schedule) per Stripe customer.
async function withTrialPlanLock<T>(c: Context, customerId: string, run: () => Promise<T>): Promise<T> {
  const pool = await getPgClient(c)
  let client: Awaited<ReturnType<typeof checkoutPgClient>> | null = null
  let broken = false
  try {
    client = await checkoutPgClient(pool)
    const { result, connectionLost } = await holdTrialPlanLock(c, client, customerId, run)
    broken = connectionLost
    return result
  }
  finally {
    releasePgClient(pool, client, broken)
    closeClient(c, pool)
  }
}

// "Start now": begin the trial plan today instead of when the trial ends. Stripe's billing
// period starts today and the billing cycle (subscription_anchor_start/end) follows it. Usage
// is summed per UTC day from the cycle start date, so today's usage stays in the new cycle.
export async function startTrialPlanNow(
  c: Context,
  ctx: InAppBillingContext,
  orgId: string,
  attribution: TrialPlanAttribution = {},
  productId?: string,
) {
  const state = await applyTrialPlanProduct(c, ctx, productId)
  if (!state)
    throw simpleError('trial_plan_unavailable', 'This organization is not on a free trial')
  if (!await ensureDefaultPaymentMethod(ctx))
    throw simpleError('missing_payment_method', 'Add a card before starting the plan')
  await ensureCustomerTaxAddress(ctx)
  const metadata = attributionMetadata(attribution)
  if (Object.keys(metadata).length)
    await ctx.stripe.customers.update(ctx.customerId, { metadata })
  const customer = await ctx.stripe.customers.retrieve(ctx.customerId)
  const defaultPaymentMethod = customer.deleted ? null : customer.invoice_settings?.default_payment_method
  const paymentMethodId = typeof defaultPaymentMethod === 'string' ? defaultPaymentMethod : defaultPaymentMethod?.id
  if (!paymentMethodId)
    throw simpleError('missing_payment_method', 'Add a card before starting the plan')

  const { subscription, reused } = await withTrialPlanLock(c, ctx.customerId, async () => {
    const created = await createStartNowSubscription(ctx.stripe, {
      customerId: ctx.customerId,
      orgId,
      priceId: state.priceId,
      paymentMethodId,
      automaticTax: isAutomaticTaxEnabled(ctx.billingAccount),
      metadata,
    })
    // The plan already started: a pending trial-end schedule would bill a second subscription.
    // Cleaning up under the lock means no schedule can be created after it. The webhook
    // repeats this for the new subscription, so a failure here is retried there.
    try {
      await cancelAllPendingTrialPlanSchedules(c, ctx.stripe, ctx.customerId, `trial plan schedule replaced by start now ${created.subscription.id}`)
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'trial plan start now schedule cleanup failed', orgId, subscriptionId: created.subscription.id, error })
    }
    return created
  })
  cloudlog({ requestId: c.get('requestId'), message: reused ? 'trial plan already started now' : 'trial plan started now', orgId, subscriptionId: subscription.id, productId: state.productId })
  // A reused subscription may be on another plan than this request picked: report what Stripe
  // bills and put the org's selected product back to it.
  const subscribedPrice = subscription.items?.data[0]?.price
  const subscribedPriceId = typeof subscribedPrice === 'string' ? subscribedPrice : subscribedPrice?.id
  const price = await ctx.stripe.prices.retrieve(reused && subscribedPriceId ? subscribedPriceId : state.priceId)
  let planName = state.planName
  let planProductId = state.productId
  if (price.id !== state.priceId) {
    planProductId = typeof price.product === 'string' ? price.product : price.product.id
    const { data: plan } = await findPlanByProductId(c, planProductId)
    planName = plan?.name ?? ''
    const { error } = await supabaseAdmin(c)
      .from('stripe_info')
      .update({ product_id: planProductId })
      .eq('customer_id', ctx.customerId)
    if (error)
      cloudlogErr({ requestId: c.get('requestId'), message: 'trial plan start now product restore failed', orgId, subscriptionId: subscription.id, error })
  }
  const summary: TrialPlanSummary = {
    planName,
    productId: planProductId,
    amount: price.unit_amount ?? 0,
    currency: price.currency,
    interval: 'month',
    startsAt: new Date(subscription.created * 1000).toISOString(),
    scheduled: false,
  }
  if (!reused)
    await notifyBento(c, orgId, c.get('auth')?.userId, 'started_now', summary)
  return { plan: summary, subscriptionId: subscription.id }
}

export async function cancelTrialPlan(c: Context, ctx: InAppBillingContext, orgId: string) {
  // Cancel before enriching the summary so a temporary Stripe/price error cannot leave the charge active.
  const schedule = await findPendingTrialPlanSchedule(ctx.stripe, ctx.customerId)
  const canceled = await cancelAllPendingTrialPlanSchedules(c, ctx.stripe, ctx.customerId, 'trial plan schedule canceled')
  if (!canceled)
    return getTrialPlanSummary(c, ctx)
  let summary: TrialPlanSummary | null = null
  if (schedule) {
    try {
      summary = await summarizePendingSchedule(c, ctx, schedule)
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'trial plan cancel summary enrichment failed', orgId, error })
      const phase = schedule.phases[0]
      summary = {
        planName: '',
        productId: '',
        amount: 0,
        currency: 'usd',
        interval: 'month',
        startsAt: phase ? new Date(phase.start_date * 1000).toISOString() : new Date().toISOString(),
        scheduled: true,
      }
    }
  }
  const next = summary ? { ...summary, scheduled: false } : null
  if (next)
    await notifyBento(c, orgId, c.get('auth')?.userId, 'canceled', next)
  return next
}

// A subscription bought through checkout replaces the scheduled trial plan: drop the schedule
// so the customer is not billed twice when the trial ends.
// Only a subscription that is live (paid checkout) replaces the trial plan; an incomplete
// checkout that is abandoned must keep the scheduled plan.
const REPLACING_SUBSCRIPTION_STATUSES = new Set<Stripe.Subscription.Status>(['active', 'trialing'])

// A trial plan started now (no schedule) replaces the pending trial-end schedule too.
export async function cancelTrialPlanScheduleForSubscription(c: Context, stripe: Stripe, subscription: Stripe.Subscription) {
  if (subscription.schedule || (isTrialPlanSubscription(subscription) && !isTrialPlanStartedNow(subscription)) || !REPLACING_SUBSCRIPTION_STATUSES.has(subscription.status))
    return
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
  await cancelAllPendingTrialPlanSchedules(c, stripe, customerId, `trial plan schedule replaced by subscription ${subscription.id}`)
}

// A trial plan subscription whose first invoice never got paid (e.g. Stripe gave up on it).
export async function isTrialPlanFirstInvoiceUnpaid(stripe: Stripe, subscription: Stripe.Subscription) {
  if (!isTrialPlanSubscription(subscription))
    return false
  const invoiceId = typeof subscription.latest_invoice === 'string' ? subscription.latest_invoice : subscription.latest_invoice?.id
  if (!invoiceId)
    return true
  const invoice = typeof subscription.latest_invoice === 'object' && subscription.latest_invoice
    ? subscription.latest_invoice
    : await stripe.invoices.retrieve(invoiceId)
  return invoice.billing_reason === 'subscription_create' && invoice.status !== 'paid'
}

export function isTrialPlanSubscription(subscription: Stripe.Subscription) {
  return subscription.metadata?.[TRIAL_PLAN_SCHEDULE_METADATA_KEY] === 'true'
}

// first_paid: the first invoice is paid (convert). unpaid: still waiting for it.
// renewal: a later invoice, handled by the normal subscription flow.
export type TrialPlanFirstInvoiceState = 'first_paid' | 'unpaid' | 'renewal'

// A schedule-born subscription is active before its first invoice is paid (Stripe finalizes it
// about an hour later). Charge it now and only let the org convert once it is paid; on failure
// the subscription goes past_due and the regular dunning flow takes over.
// Statuses in which we may still collect the first invoice. A canceled or expired
// subscription must never be charged, even by a delayed webhook carrying an old snapshot.
const COLLECTIBLE_SUBSCRIPTION_STATUSES = new Set<Stripe.Subscription.Status>(['active', 'past_due'])

export async function settleTrialPlanFirstInvoice(c: Context, stripe: Stripe, eventSubscription: Stripe.Subscription): Promise<TrialPlanFirstInvoiceState> {
  // Work from the live subscription, not the webhook snapshot.
  const subscription = await stripe.subscriptions.retrieve(eventSubscription.id)
  const invoiceId = typeof subscription.latest_invoice === 'string' ? subscription.latest_invoice : subscription.latest_invoice?.id
  if (!invoiceId)
    return 'unpaid'
  let invoice = await stripe.invoices.retrieve(invoiceId)
  if (invoice.billing_reason !== 'subscription_create')
    return 'renewal'
  if (invoice.status !== 'paid' && !COLLECTIBLE_SUBSCRIPTION_STATUSES.has(subscription.status)) {
    cloudlog({ requestId: c.get('requestId'), message: 'trial plan first invoice not collected: subscription no longer live', subscriptionId: subscription.id, status: subscription.status })
    return 'unpaid'
  }
  try {
    if (invoice.status === 'draft')
      invoice = await stripe.invoices.finalizeInvoice(invoice.id)
    if (invoice.status === 'open')
      invoice = await stripe.invoices.pay(invoice.id, { off_session: true })
  }
  catch (error) {
    // Card declined, authentication required, or another event already finalized/paid it.
    cloudlog({ requestId: c.get('requestId'), message: 'trial plan first invoice not paid yet', subscriptionId: subscription.id, invoiceId, error })
    invoice = await stripe.invoices.retrieve(invoiceId)
  }
  if (invoice.status !== 'paid')
    return 'unpaid'
  // The schedule only existed to start the plan: release it so plan changes and
  // cancellation work like any other subscription.
  if (subscription.schedule)
    await releaseTrialPlanSchedule(c, stripe, subscription.id)
  return 'first_paid'
}

// Stripe rejects direct updates to a subscription a schedule still manages. Release the
// trial plan schedule (it only existed to start the plan) so cancel/resume work; other
// schedules keep their future phases.
export async function releaseTrialPlanSchedule(c: Context, stripe: Stripe, subscriptionId: string) {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId)
  const scheduleId = typeof subscription.schedule === 'string' ? subscription.schedule : subscription.schedule?.id
  if (!scheduleId)
    return
  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId)
  if (schedule.metadata?.[TRIAL_PLAN_SCHEDULE_METADATA_KEY] !== 'true' || (schedule.status !== 'active' && schedule.status !== 'not_started'))
    return
  try {
    await stripe.subscriptionSchedules.release(scheduleId)
  }
  catch (error) {
    // A concurrent caller (webhook settlement vs. in-app cancel) may have released it first.
    const latest = await stripe.subscriptionSchedules.retrieve(scheduleId)
    if (latest.status === 'active' || latest.status === 'not_started')
      throw error
    return
  }
  cloudlog({ requestId: c.get('requestId'), message: 'trial plan schedule released', subscriptionId, scheduleId })
}
