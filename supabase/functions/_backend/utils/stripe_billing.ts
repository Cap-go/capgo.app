import type { Context } from 'hono'
import type { PriceTier } from './country_price_tier.ts'
import type { Database } from './supabase.types.ts'
import { isPriceTier } from './country_price_tier.ts'
import { cloudlogErr } from './logging.ts'
import { queryJson, servicePrincipal, withRlsContext } from './pg_rls.ts'
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

export function getRequestCountry(c: Context): string | null {
  // Cloudflare sets request.cf.country; the header covers Supabase/proxied requests.
  const raw = (c.req.raw as { cf?: { country?: unknown } } | undefined)?.cf?.country ?? c.req.header('cf-ipcountry')
  if (typeof raw !== 'string')
    return null
  const country = raw.trim().toUpperCase()
  return /^[A-Z]{2}$/.test(country) ? country : null
}

// The US entity is only offered to US visitors: it bills without automatic tax.
export function canChooseUsBillingAccount(c: Context): boolean {
  return getRequestCountry(c) === 'US' && isStripeAccountReadyForNewCustomers(c, 'us')
}

// US visitors default to the US entity once it is ready; everyone else stays on EE.
export function getSuggestedBillingAccount(c: Context): BillingAccount {
  return canChooseUsBillingAccount(c) ? 'us' : 'ee'
}

// New orgs: an explicit user choice wins, otherwise fall back to the geo suggestion.
export function resolveNewOrgBillingAccount(c: Context, requested?: BillingAccount | null): BillingAccount {
  if (requested === 'us')
    return canChooseUsBillingAccount(c) ? 'us' : 'ee'
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

export function getStripePublishableKeyEnvName(account: BillingAccount): string {
  return account === 'us' ? 'STRIPE_PUBLISHABLE_KEY_US' : 'STRIPE_PUBLISHABLE_KEY'
}

// Public key for the in-app Stripe.js forms; empty means billing UI falls back to hosted pages.
export function getStripePublishableKey(c: Context, account: BillingAccount = 'ee'): string {
  const key = getEnv(c, getStripePublishableKeyEnvName(account)).trim()
  return key.startsWith('pk_') ? key : ''
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

// Fail closed: no new customers on an account whose webhook is not wired, or their subscriptions never sync.
export function isStripeAccountReadyForNewCustomers(c: Context, account: BillingAccount): boolean {
  return isStripeConfiguredForAccount(c, account) && getStripeWebhookSecret(c, account).trim().startsWith('whsec_')
}

// A customer lives on an account whose key is missing: never fake success for it.
export class BillingAccountUnavailableError extends Error {
  constructor(readonly billingAccount: BillingAccount) {
    super(`Stripe account ${billingAccount} is not configured`)
    this.name = 'BillingAccountUnavailableError'
  }
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
  try {
    const billingAccount = await withRlsContext(c, servicePrincipal, async (client) => {
      const result = await client.query<{ billing_account: string | null }>(
        'SELECT billing_account FROM public.stripe_info WHERE customer_id = $1 LIMIT 2',
        [customerId],
      )
      return singleRowOrNull(result.rows)?.billing_account
    })
    return normalizeBillingAccount(billingAccount)
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'getBillingAccountForCustomer',
      customerId,
      error,
    })
    throw error
  }
}

/** Like supabase-js `.maybeSingle()`: null for no row, PGRST116 error for several. */
export function singleRowOrNull<T>(rows: T[]): T | null {
  if (rows.length > 1)
    throw Object.assign(new Error('JSON object requested, multiple (or no) rows returned'), { code: 'PGRST116' })
  return rows[0] ?? null
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

// The tier's Stripe price from plans.regional_price_ids; null when the plan has none, so it sells the full price.
export function getRegionalPlanPriceId(regionalPriceIds: unknown, tier: PriceTier, account: BillingAccount, recurrence: string): string | null {
  if (!regionalPriceIds || typeof regionalPriceIds !== 'object')
    return null
  const ids = (regionalPriceIds as Record<string, unknown>)[tier]
  if (!ids || typeof ids !== 'object')
    return null
  const column = `${recurrence === 'year' ? 'price_y_id' : 'price_m_id'}${account === 'us' ? '_us' : ''}`
  const priceId = (ids as Record<string, unknown>)[column]
  return typeof priceId === 'string' && priceId.trim() ? priceId.trim() : null
}

// Tier of a regional Stripe price listed in plans.regional_price_ids; null for any other price.
export function getRegionalPriceTier(regionalPriceIds: unknown, priceId: string): PriceTier | null {
  if (!regionalPriceIds || typeof regionalPriceIds !== 'object')
    return null
  for (const [tier, ids] of Object.entries(regionalPriceIds)) {
    if (isPriceTier(tier) && ids && typeof ids === 'object' && Object.values(ids).includes(priceId))
      return tier
  }
  return null
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

type PlanRow = Database['public']['Tables']['plans']['Row']

/** The plan whose EE or US product is `productId` (`.or(planProductIdOrFilter(id)).maybeSingle()`), as PostgREST JSON. */
export async function queryPlanByProductId(client: Parameters<typeof queryJson>[0], productId: string): Promise<PlanRow | null> {
  planProductIdOrFilter(productId)
  const rows = await queryJson<PlanRow>(client, 'SELECT * FROM public.plans WHERE stripe_id = $1 OR stripe_id_us = $1 LIMIT 2', [productId])
  return singleRowOrNull(rows)
}

export async function findPlanByProductId(c: Context, productId: string): Promise<{ data: PlanRow | null, error: unknown }> {
  try {
    const data = await withRlsContext(c, servicePrincipal, client => queryPlanByProductId(client, productId))
    return { data, error: null }
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

// Marks the subscription schedule (and the subscription it starts) that begins the
// onboarding plan when the free trial ends.
export const TRIAL_PLAN_SCHEDULE_METADATA_KEY = 'capgo_trial_plan'

// The US entity has no sales tax registrations yet; collect tax only on the EE account.
export function isAutomaticTaxEnabled(billingAccount: BillingAccount): boolean {
  return billingAccount !== 'us'
}
