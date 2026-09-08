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
  return flag === 'us' ? 'us' : 'ee'
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

function requireUsPlanField(value: string | null | undefined, field: string): string {
  if (!value)
    throw new IncompleteUsPlanConfigError(field)
  return value
}

export async function getBillingAccountForCustomer(c: Context, customerId: string): Promise<BillingAccount> {
  const admin = supabaseAdmin(c)
  if (!admin?.from) {
    // Unit/emulator tests stub supabaseAdmin without a client. Production always
    // has service-role access; default to ee here instead of failing checkout.
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'getBillingAccountForCustomer unavailable admin client, defaulting to ee',
      customerId,
    })
    return 'ee'
  }

  const { data, error } = await admin
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

export function getPlanCreditProductId(plan: PlanStripeIds, account: BillingAccount): string {
  if (account === 'us')
    return requireUsPlanField(plan.credit_id_us, 'credit_id_us')
  return plan.credit_id ?? ''
}

export function planProductIdOrFilter(productId: string): string {
  return `stripe_id.eq.${productId},stripe_id_us.eq.${productId}`
}

export async function findPlanByProductId(c: Context, productId: string) {
  try {
    const admin = supabaseAdmin(c)
    if (!admin?.from)
      return { data: null, error: null }

    return await admin
      .from('plans')
      .select('*')
      .or(planProductIdOrFilter(productId))
      .maybeSingle()
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'findPlanByProductId unavailable admin client',
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
  const { data: plan } = await findPlanByProductId(c, planProductId)
  if (!plan)
    return planProductId
  return getPlanProductId(plan, billingAccount)
}
