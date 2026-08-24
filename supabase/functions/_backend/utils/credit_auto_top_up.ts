import type { Context } from 'hono'
import type Stripe from 'stripe'
import { getFallbackCreditProductId } from './credits.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { getOneTimePriceId, getStripe, isStripeEmulatorEnabled } from './stripe.ts'
import { supabaseAdmin } from './supabase.ts'
import { isStripeConfigured } from './utils.ts'

export const MIN_AUTO_TOP_UP_THRESHOLD = 10
export const AUTO_TOP_UP_KIND = 'credit_auto_top_up'
const AUTO_TOP_UP_SOURCE = 'stripe_top_up'

export interface AutoTopUpSettings {
  enabled: boolean
  threshold: number
  hasPaymentMethod: boolean
  availableCredits: number
}

// Mirrors try_claim_credit_auto_top_up eligibility (enabled, min $10, balance, 1h cooldown).
// SQL remains the source of truth for charging; this helper exists for unit tests.
export function shouldAttemptAutoTopUp(input: {
  enabled: boolean
  availableCredits: number
  threshold: number
  lastAttemptAt: string | null
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
    const paymentMethod = await stripe.paymentMethods.retrieve(defaultPmId)
    if (paymentMethod.type === 'card')
      return paymentMethod.id
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
): Promise<void> {
  const sourceRef = {
    paymentIntentId,
    kind: AUTO_TOP_UP_KIND,
    quantity,
  }
  const { error } = await supabaseAdmin(c)
    .rpc('top_up_usage_credits', {
      p_org_id: orgId,
      p_amount: quantity,
      p_source: AUTO_TOP_UP_SOURCE,
      p_notes: 'Automatic credit top-up',
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

  const idempotencyKey = `credit_auto_top_up:${orgId}:${quantity}:${Math.floor(Date.now() / (60 * 60 * 1000))}`
  try {
    return await stripe.paymentIntents.create({
      amount: unitAmount * quantity,
      currency: price.currency,
      customer: customerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      metadata: {
        kind: AUTO_TOP_UP_KIND,
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
    .select('auto_top_up_enabled, auto_top_up_threshold, customer_id')
    .eq('id', orgId)
    .maybeSingle()

  if (error || !org) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'credit_auto_top_up_settings_lookup_failed', orgId, error })
    return {
      enabled: false,
      threshold: MIN_AUTO_TOP_UP_THRESHOLD,
      hasPaymentMethod: false,
      availableCredits: 0,
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
  }
}

export async function saveAutoTopUpSettings(
  c: Context,
  orgId: string,
  enabled: boolean,
  threshold: number,
): Promise<AutoTopUpSettings> {
  const { data: org, error: orgError } = await supabaseAdmin(c)
    .from('orgs')
    .select('customer_id')
    .eq('id', orgId)
    .maybeSingle()

  if (orgError || !org)
    throw orgError ?? new Error('stripe_customer_missing')

  if (enabled) {
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
    })
    .eq('id', orgId)

  if (updateError) {
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

  const paymentIntent = await chargeOffSessionCredits(c, orgId, claim.customer_id, quantity)
  if (!paymentIntent || paymentIntent.status !== 'succeeded')
    return

  await grantCreditsFromAutoTopUpPayment(c, orgId, quantity, paymentIntent.id)
}

export async function handleAutoTopUpPaymentIntent(c: Context, event: Stripe.Event, orgId: string): Promise<boolean> {
  if (event.type !== 'payment_intent.succeeded')
    return false

  const paymentIntent = event.data.object as Stripe.PaymentIntent
  if (paymentIntent.metadata?.kind !== AUTO_TOP_UP_KIND)
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

  await grantCreditsFromAutoTopUpPayment(c, orgId, quantity, paymentIntent.id)
  return true
}
