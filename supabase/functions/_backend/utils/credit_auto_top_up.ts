import type { Context } from 'hono'
import Stripe from 'stripe'
import { getFallbackCreditProductId } from './credits.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { getOneTimePriceId, getStripe, isStripeEmulatorEnabled } from './stripe.ts'
import { supabaseAdmin } from './supabase.ts'
import { isStripeConfigured } from './utils.ts'

export const MIN_AUTO_TOP_UP_THRESHOLD = 10
// orgs.auto_top_up_monthly_limit is numeric(18,6): 12 integer digits max.
export const MAX_AUTO_TOP_UP_MONTHLY_LIMIT = 999_999_999_999
export const AUTO_TOP_UP_KIND = 'credit_auto_top_up'
export const CYCLE_TOP_UP_KIND = 'credit_cycle_top_up'
type TopUpKind = typeof AUTO_TOP_UP_KIND | typeof CYCLE_TOP_UP_KIND
const AUTO_TOP_UP_SOURCE = 'stripe_top_up'

export interface AutoTopUpSettings {
  enabled: boolean
  threshold: number
  hasPaymentMethod: boolean
  availableCredits: number
  /** Max credits auto top-up may buy per calendar month (UTC). 0 means no limit. */
  monthlyLimit: number
  /** Credits bought by auto top-up so far this calendar month (UTC). null when the lookup failed. */
  monthlyTotal: number | null
  /** Buy cycleAmount credits once per billing cycle. Independent from the threshold top-up. */
  cycleEnabled: boolean
  cycleAmount: number
  /** End of the current billing cycle, i.e. when the next scheduled top-up runs. null when unknown. */
  cycleEnd: string | null
}

export interface AutoTopUpSettingsUpdate {
  enabled: boolean
  threshold: number
  monthlyLimit?: number
  cycleEnabled?: boolean
  cycleAmount?: number
}

// Mirrors try_claim_credit_auto_top_up eligibility (enabled, min $10, balance, 1h cooldown, monthly limit).
// SQL remains the source of truth for charging; this helper exists for unit tests.
export function shouldAttemptAutoTopUp(input: {
  enabled: boolean
  availableCredits: number
  threshold: number
  lastAttemptAt: string | null
  monthlyLimit?: number
  monthlyTotal?: number
  now?: number
  cooldownMs?: number
}): boolean {
  if (!input.enabled)
    return false
  if (!Number.isFinite(input.threshold) || input.threshold < MIN_AUTO_TOP_UP_THRESHOLD)
    return false
  if (input.availableCredits >= input.threshold)
    return false
  const cooldownMs = input.cooldownMs ?? 60 * 60 * 1000
  if (input.lastAttemptAt) {
    const lastAttempt = Date.parse(input.lastAttemptAt)
    if (Number.isFinite(lastAttempt) && (input.now ?? Date.now()) - lastAttempt < cooldownMs)
      return false
  }
  const monthlyLimit = input.monthlyLimit ?? 0
  if (monthlyLimit > 0 && (input.monthlyTotal ?? 0) + input.threshold > monthlyLimit)
    return false
  return true
}

export function normalizeAutoTopUpThreshold(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed))
    return null
  const rounded = Math.floor(parsed)
  if (rounded < MIN_AUTO_TOP_UP_THRESHOLD)
    return null
  return rounded
}

// Scheduled top-up amount: whole credits, at least $10, within the numeric(18,6) column range.
export function normalizeCycleTopUpAmount(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === ''))
    return null
  const normalized = normalizeAutoTopUpThreshold(value)
  if (normalized === null || normalized > MAX_AUTO_TOP_UP_MONTHLY_LIMIT)
    return null
  return normalized
}

// 0 means no limit. Otherwise the limit must allow at least one top-up of `threshold`.
export function normalizeAutoTopUpMonthlyLimit(value: unknown, threshold: number): number | null {
  // Reject null, booleans and empty strings so malformed input never becomes "no limit".
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === ''))
    return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_AUTO_TOP_UP_MONTHLY_LIMIT)
    return null
  const rounded = Math.floor(parsed)
  if (rounded !== 0 && rounded < threshold)
    return null
  return rounded
}

async function getMonthlyAutoTopUpTotal(c: Context, orgId: string): Promise<number | null> {
  const { data, error } = await supabaseAdmin(c)
    .rpc('get_credit_auto_top_up_month_total', { p_org_id: orgId })
  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'credit_auto_top_up_month_total_failed', orgId, error })
    // Report "unknown" instead of 0 so the UI never shows false usage, without failing the read or a committed save.
    return null
  }
  return Number(data ?? 0)
}

async function getBillingCycleEnd(c: Context, orgId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin(c)
    .rpc('get_org_billing_cycle', { orgid: orgId })
    .maybeSingle()
  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'credit_cycle_top_up_cycle_lookup_failed', orgId, error })
    return null
  }
  return data?.cycle_end ?? null
}

async function getAvailableCredits(c: Context, orgId: string): Promise<number> {
  const { data, error } = await supabaseAdmin(c)
    .from('usage_credit_balances')
    .select('available_credits')
    .eq('org_id', orgId)
    .maybeSingle()
  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'credit_auto_top_up_balance_failed', orgId, error })
    return 0
  }
  return Number(data?.available_credits ?? 0)
}

export async function customerHasSavedPaymentMethod(c: Context, customerId: string): Promise<boolean> {
  if (!isStripeConfigured(c))
    return false
  try {
    return Boolean(await getDefaultPaymentMethodId(c, customerId))
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'credit_auto_top_up_payment_method_lookup_failed', customerId, error })
    return false
  }
}

async function getDefaultPaymentMethodId(c: Context, customerId: string): Promise<string | null> {
  const stripe = getStripe(c)
  const customer = await stripe.customers.retrieve(customerId)
  if (customer.deleted)
    return null
  const defaultPm = customer.invoice_settings?.default_payment_method
  const defaultPmId = typeof defaultPm === 'string'
    ? defaultPm
    : defaultPm && typeof defaultPm === 'object' && 'id' in defaultPm
      ? defaultPm.id
      : null
  if (defaultPmId) {
    try {
      const paymentMethod = await stripe.paymentMethods.retrieve(defaultPmId)
      if (paymentMethod.type === 'card')
        return paymentMethod.id
    }
    catch (error) {
      if (!(error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'resource_missing'))
        throw error
      // Fall through to the saved-card list when the default method is gone.
    }
  }
  const cards = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 })
  return cards.data[0]?.id ?? null
}

async function getCreditProductIdForCustomer(c: Context, customerId: string): Promise<string> {
  const loadSoloPlan = async () => {
    const { data, error } = await supabaseAdmin(c)
      .from('plans')
      .select('credit_id')
      .eq('name', 'Solo')
      .maybeSingle()
    if (error)
      throw error
    return data ?? null
  }

  const { data: stripeInfo, error: stripeInfoError } = await supabaseAdmin(c)
    .from('stripe_info')
    .select('product_id')
    .eq('customer_id', customerId)
    .maybeSingle()

  if (stripeInfoError || !stripeInfo?.product_id)
    return await getFallbackCreditProductId(c, customerId, loadSoloPlan)

  const { data: plan, error: planError } = await supabaseAdmin(c)
    .from('plans')
    .select('credit_id, name')
    .eq('stripe_id', stripeInfo.product_id)
    .maybeSingle()

  if (planError || !plan?.credit_id)
    return await getFallbackCreditProductId(c, customerId, loadSoloPlan)

  return plan.credit_id
}

export async function grantCreditsFromAutoTopUpPayment(
  c: Context,
  orgId: string,
  quantity: number,
  paymentIntentId: string,
  kind: TopUpKind = AUTO_TOP_UP_KIND,
): Promise<void> {
  const sourceRef = {
    paymentIntentId,
    kind,
    quantity,
  }
  const { error } = await supabaseAdmin(c)
    .rpc('top_up_usage_credits', {
      p_org_id: orgId,
      p_amount: quantity,
      p_source: AUTO_TOP_UP_SOURCE,
      p_notes: kind === CYCLE_TOP_UP_KIND ? 'Scheduled credit top-up' : 'Automatic credit top-up',
      p_source_ref: sourceRef,
    })
    .single()

  if (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'credit_auto_top_up_grant_failed',
      orgId,
      paymentIntentId,
      error,
    })
    throw error
  }
}

async function chargeOffSessionCredits(
  c: Context,
  orgId: string,
  customerId: string,
  quantity: number,
  kind: TopUpKind,
  idempotencyKey: string,
): Promise<Stripe.PaymentIntent | null> {
  const paymentMethodId = await getDefaultPaymentMethodId(c, customerId)
  if (!paymentMethodId) {
    cloudlog({ requestId: c.get('requestId'), message: 'credit_auto_top_up_skipped_no_payment_method', orgId, customerId })
    return null
  }

  const productId = await getCreditProductIdForCustomer(c, customerId)
  const priceId = await getOneTimePriceId(c, productId)
  if (!priceId) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'credit_auto_top_up_missing_price', orgId, productId })
    return null
  }

  const stripe = getStripe(c)
  const price = await stripe.prices.retrieve(priceId)
  const unitAmount = price.unit_amount
  if (!unitAmount || unitAmount <= 0) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'credit_auto_top_up_invalid_unit_amount', orgId, priceId })
    return null
  }

  try {
    return await stripe.paymentIntents.create({
      amount: unitAmount * quantity,
      currency: price.currency,
      customer: customerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      metadata: {
        kind,
        orgId,
        productId,
        intendedQuantity: String(quantity),
      },
    }, { idempotencyKey })
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'credit_auto_top_up_charge_failed',
      orgId,
      customerId,
      error,
      emulator: isStripeEmulatorEnabled(c),
    })
    return null
  }
}

export async function getAutoTopUpSettings(c: Context, orgId: string): Promise<AutoTopUpSettings> {
  const { data: org, error } = await supabaseAdmin(c)
    .from('orgs')
    .select('auto_top_up_enabled, auto_top_up_threshold, auto_top_up_monthly_limit, auto_top_up_cycle_enabled, auto_top_up_cycle_amount, customer_id')
    .eq('id', orgId)
    .maybeSingle()

  if (error || !org) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'credit_auto_top_up_settings_lookup_failed', orgId, error })
    return {
      enabled: false,
      threshold: MIN_AUTO_TOP_UP_THRESHOLD,
      hasPaymentMethod: false,
      availableCredits: 0,
      monthlyLimit: 0,
      monthlyTotal: null,
      cycleEnabled: false,
      cycleAmount: MIN_AUTO_TOP_UP_THRESHOLD,
      cycleEnd: null,
    }
  }

  const hasPaymentMethod = org.customer_id
    ? await customerHasSavedPaymentMethod(c, org.customer_id)
    : false

  return {
    enabled: Boolean(org.auto_top_up_enabled),
    threshold: Number(org.auto_top_up_threshold ?? MIN_AUTO_TOP_UP_THRESHOLD),
    hasPaymentMethod,
    availableCredits: await getAvailableCredits(c, orgId),
    monthlyLimit: Number(org.auto_top_up_monthly_limit ?? 0),
    monthlyTotal: await getMonthlyAutoTopUpTotal(c, orgId),
    cycleEnabled: Boolean(org.auto_top_up_cycle_enabled),
    cycleAmount: Number(org.auto_top_up_cycle_amount ?? MIN_AUTO_TOP_UP_THRESHOLD),
    cycleEnd: await getBillingCycleEnd(c, orgId),
  }
}

export async function saveAutoTopUpSettings(
  c: Context,
  orgId: string,
  update: AutoTopUpSettingsUpdate,
): Promise<AutoTopUpSettings> {
  const { enabled, threshold, monthlyLimit, cycleEnabled, cycleAmount } = update
  const { data: org, error: orgError } = await supabaseAdmin(c)
    .from('orgs')
    .select('customer_id, auto_top_up_monthly_limit')
    .eq('id', orgId)
    .maybeSingle()

  if (orgError || !org)
    throw orgError ?? new Error('stripe_customer_missing')

  // When the caller keeps the stored limit, it must still allow one top-up at the new threshold.
  if (monthlyLimit === undefined && normalizeAutoTopUpMonthlyLimit(Number(org.auto_top_up_monthly_limit ?? 0), threshold) === null)
    throw new Error('invalid_monthly_limit')

  if (enabled || cycleEnabled) {
    if (!org.customer_id)
      throw new Error('stripe_customer_missing')
    const hasPaymentMethod = await customerHasSavedPaymentMethod(c, org.customer_id)
    if (!hasPaymentMethod)
      throw new Error('payment_method_required')
  }

  const { error: updateError } = await supabaseAdmin(c)
    .from('orgs')
    .update({
      auto_top_up_enabled: enabled,
      auto_top_up_threshold: threshold,
      ...(monthlyLimit === undefined ? {} : { auto_top_up_monthly_limit: monthlyLimit }),
      ...(cycleEnabled === undefined ? {} : { auto_top_up_cycle_enabled: cycleEnabled }),
      ...(cycleAmount === undefined ? {} : { auto_top_up_cycle_amount: cycleAmount }),
    })
    .eq('id', orgId)

  if (updateError) {
    // A concurrent save can still break the limit >= threshold rule; the DB constraint rejects it.
    if (updateError.code === '23514' && updateError.message?.includes('orgs_auto_top_up_monthly_limit_valid')) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'credit_auto_top_up_monthly_limit_constraint_failed', orgId, error: updateError })
      throw new Error('invalid_monthly_limit')
    }
    cloudlogErr({ requestId: c.get('requestId'), message: 'credit_auto_top_up_settings_update_failed', orgId, error: updateError })
    throw updateError
  }

  return await getAutoTopUpSettings(c, orgId)
}

export async function maybeAutoTopUpCredits(c: Context, orgId: string): Promise<void> {
  if (!isStripeConfigured(c))
    return

  const { data: claim, error: claimError } = await supabaseAdmin(c)
    .rpc('try_claim_credit_auto_top_up', { p_org_id: orgId })
    .maybeSingle()

  if (claimError) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'credit_auto_top_up_claim_failed', orgId, error: claimError })
    return
  }

  if (!claim?.claimed || !claim.customer_id)
    return

  const quantity = Math.floor(Number(claim.auto_top_up_threshold ?? 0))
  if (quantity < MIN_AUTO_TOP_UP_THRESHOLD)
    return

  const idempotencyKey = `credit_auto_top_up:${orgId}:${quantity}:${Math.floor(Date.now() / (60 * 60 * 1000))}`
  const paymentIntent = await chargeOffSessionCredits(c, orgId, claim.customer_id, quantity, AUTO_TOP_UP_KIND, idempotencyKey)
  if (!paymentIntent || paymentIntent.status !== 'succeeded')
    return

  await grantCreditsFromAutoTopUpPayment(c, orgId, quantity, paymentIntent.id)
}

// Charge states where no money moved and none will without customer action: retry next window.
const CYCLE_TOP_UP_RETRYABLE_STATUSES = new Set<Stripe.PaymentIntent.Status>(['requires_payment_method', 'requires_action', 'requires_confirmation', 'canceled'])

export async function maybeCycleTopUpCredits(c: Context, orgId: string): Promise<void> {
  if (!isStripeConfigured(c))
    return

  const { data: claim, error: claimError } = await supabaseAdmin(c)
    .rpc('try_claim_credit_cycle_top_up', { p_org_id: orgId })
    .maybeSingle()

  if (claimError) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'credit_cycle_top_up_claim_failed', orgId, error: claimError })
    return
  }

  if (!claim?.claimed || !claim.customer_id || !claim.cycle_start)
    return

  const release = async () => {
    const { error } = await supabaseAdmin(c)
      .rpc('release_credit_cycle_top_up', {
        p_org_id: orgId,
        p_cycle_start: claim.cycle_start!,
        p_previous_paid_for: claim.previous_paid_for ?? undefined,
      })
    if (error)
      cloudlogErr({ requestId: c.get('requestId'), message: 'credit_cycle_top_up_release_failed', orgId, error })
  }

  const quantity = Math.floor(Number(claim.amount ?? 0))
  if (quantity < MIN_AUTO_TOP_UP_THRESHOLD) {
    await release()
    return
  }

  // One key per cycle and 6h retry window: a retried cron run in the same window cannot charge twice.
  const idempotencyKey = `${CYCLE_TOP_UP_KIND}:${orgId}:${claim.cycle_start}:${Math.floor(Date.now() / (6 * 60 * 60 * 1000))}`
  const paymentIntent = await chargeOffSessionCredits(c, orgId, claim.customer_id, quantity, CYCLE_TOP_UP_KIND, idempotencyKey)
  if (!paymentIntent || CYCLE_TOP_UP_RETRYABLE_STATUSES.has(paymentIntent.status)) {
    await release()
    return
  }
  // processing: the payment_intent.succeeded webhook grants the credits later.
  if (paymentIntent.status !== 'succeeded')
    return

  await grantCreditsFromAutoTopUpPayment(c, orgId, quantity, paymentIntent.id, CYCLE_TOP_UP_KIND)
}

export async function handleAutoTopUpPaymentIntent(c: Context, event: Stripe.Event, orgId: string): Promise<boolean> {
  if (event.type !== 'payment_intent.succeeded')
    return false

  const paymentIntent = event.data.object as Stripe.PaymentIntent
  const kind = paymentIntent.metadata?.kind
  if (kind !== AUTO_TOP_UP_KIND && kind !== CYCLE_TOP_UP_KIND)
    return false

  const metadataOrgId = paymentIntent.metadata.orgId
  if (metadataOrgId && metadataOrgId !== orgId) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'credit_auto_top_up_org_mismatch',
      orgId,
      metadataOrgId,
      paymentIntentId: paymentIntent.id,
    })
    return true
  }

  const quantity = Math.floor(Number(paymentIntent.metadata.intendedQuantity ?? 0))
  if (quantity < MIN_AUTO_TOP_UP_THRESHOLD)
    return true

  await grantCreditsFromAutoTopUpPayment(c, orgId, quantity, paymentIntent.id, kind)
  return true
}
