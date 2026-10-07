import type { Context } from 'hono'
import { cloudlogErr } from './logging.ts'
import { supabaseAdmin } from './supabase.ts'
import { getEnv } from './utils.ts'

export type BillingAccount = 'ee' | 'us'

export interface PlanStripeIds {
  stripe_id: string
  price_m_id: string
  price_y_id: string
  credit_id?: string
  stripe_id_us?: string | null
  price_m_id_us?: string | null
  price_y_id_us?: string | null
  credit_id_us?: string | null
}

export function normalizeBillingAccount(value: string | null | undefined): BillingAccount {
  return value === 'us' ? 'us' : 'ee'
}

export function getNewCustomersBillingAccount(c: Context): BillingAccount {
  const flag = getEnv(c, 'STRIPE_NEW_CUSTOMERS_ACCOUNT').trim().toLowerCase()
  if (!flag || flag === 'ee')
    return 'ee'
  if (flag === 'us')
    return 'us'
  throw new Error(`Invalid STRIPE_NEW_CUSTOMERS_ACCOUNT value: ${JSON.stringify(flag)}`)
}

export function getRequestCountry(c: Context): string | null {
  // Cloudflare sets request.cf.country; the header covers Supabase/proxied requests.
  const raw = (c.req.raw as { cf?: { country?: unknown } } | undefined)?.cf?.country ?? c.req.header('cf-ipcountry')
  if (typeof raw !== 'string')
    return null
  const country = raw.trim().toUpperCase()
  return /^[A-Z]{2}$/.test(country) ? country : null
}

export function getSuggestedBillingAccount(c: Context): BillingAccount {
  if (getRequestCountry(c) === 'US' && isStripeConfiguredForAccount(c, 'us'))
    return 'us'
  return getNewCustomersBillingAccount(c)
}

// New orgs: an explicit user choice wins, otherwise fall back to the geo suggestion.
export function resolveNewOrgBillingAccount(c: Context, requested?: BillingAccount | null): BillingAccount {
  if (requested === 'us')
    return isStripeConfiguredForAccount(c, 'us') ? 'us' : getNewCustomersBillingAccount(c)
  if (requested === 'ee')
    return 'ee'
  return getSuggestedBillingAccount(c)
}

export function getStripeSecretKeyEnvName(account: BillingAccount): string {
  return account === 'us' ? 'STRIPE_SECRET_KEY_US' : 'STRIPE_SECRET_KEY'
}

export function getStripeWebhookSecretEnvName(account: BillingAccount): string {
  return account === 'us' ? 'STRIPE_WEBHOOK_SECRET_US' : 'STRIPE_WEBHOOK_SECRET'
}

export function getStripeSecretKey(c: Context, account: BillingAccount = 'ee'): string {
  return getEnv(c, getStripeSecretKeyEnvName(account))
}

export function getStripeWebhookSecret(c: Context, account: BillingAccount = 'ee'): string {
  return getEnv(c, getStripeWebhookSecretEnvName(account))
}

export function isStripeConfiguredForAccount(c: Context, account: BillingAccount = 'ee'): boolean {
  const secretKey = getStripeSecretKey(c, account).trim()
  if (!secretKey)
    return false
  return secretKey.startsWith('sk_') || secretKey.startsWith('rk_')
}

export class IncompleteUsPlanConfigError extends Error {
  constructor(field: string) {
    super(`Plan missing US Stripe identifier: ${field}`)
    this.name = 'IncompleteUsPlanConfigError'
  }
}

function normalizeUsPlanField(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed || null
}

function requireUsPlanField(value: string | null | undefined, field: string): string {
  const normalized = normalizeUsPlanField(value)
  if (!normalized)
    throw new IncompleteUsPlanConfigError(field)
  return normalized
}

export async function getBillingAccountForCustomer(c: Context, customerId: string): Promise<BillingAccount> {
  const { data, error } = await supabaseAdmin(c)
    .from('stripe_info')
    .select('billing_account')
    .eq('customer_id', customerId)
    .maybeSingle()

  if (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'getBillingAccountForCustomer',
      customerId,
      error,
    })
    throw error
  }

  return normalizeBillingAccount(data?.billing_account)
}

export function getPlanProductId(plan: Pick<PlanStripeIds, 'stripe_id' | 'stripe_id_us'>, account: BillingAccount): string {
  if (account === 'us')
    return requireUsPlanField(plan.stripe_id_us, 'stripe_id_us')
  return plan.stripe_id
}

export function getPlanPriceId(plan: PlanStripeIds, account: BillingAccount, recurrence: string): string {
  const yearly = recurrence === 'year'
  if (account === 'us') {
    return yearly
      ? requireUsPlanField(plan.price_y_id_us, 'price_y_id_us')
      : requireUsPlanField(plan.price_m_id_us, 'price_m_id_us')
  }
  return yearly ? plan.price_y_id : plan.price_m_id
}

export function resolvePlanCreditProductId(plan: PlanStripeIds, account: BillingAccount): string {
  if (account === 'us')
    return normalizeUsPlanField(plan.credit_id_us) ?? ''
  return plan.credit_id?.trim() ?? ''
}

export function getPlanCreditProductId(plan: PlanStripeIds, account: BillingAccount): string {
  if (account === 'us')
    return requireUsPlanField(plan.credit_id_us, 'credit_id_us')
  return plan.credit_id ?? ''
}

// Stripe product ids: prod_ + alphanumeric/underscore/hyphen (see Stripe 2018-05-21 id rules).
const STRIPE_PRODUCT_ID_REGEX = /^prod_[\w-]+$/

export function planProductIdOrFilter(productId: string): string {
  if (!STRIPE_PRODUCT_ID_REGEX.test(productId))
    throw new Error('invalid_stripe_product_id')

  return `stripe_id.eq.${productId},stripe_id_us.eq.${productId}`
}

export async function findPlanByProductId(c: Context, productId: string) {
  try {
    return await supabaseAdmin(c)
      .from('plans')
      .select('*')
      .or(planProductIdOrFilter(productId))
      .maybeSingle()
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'findPlanByProductId',
      productId,
      error,
    })
    return { data: null, error }
  }
}

export async function resolveCheckoutPlanProductId(
  c: Context,
  planProductId: string,
  billingAccount: BillingAccount,
): Promise<string> {
  const { data: plan, error } = await findPlanByProductId(c, planProductId)
  if (error)
    throw error
  if (!plan) {
    // US webhooks only accept products listed in plans.stripe_id_us.
    if (billingAccount === 'us')
      throw new IncompleteUsPlanConfigError('stripe_id_us')
    return planProductId
  }
  return getPlanProductId(plan, billingAccount)
}
