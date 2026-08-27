import type { Context } from 'hono'
import { simpleError } from './hono.ts'
import { supabaseAdmin } from './supabase.ts'
import { getEnv } from './utils.ts'

// Dual Stripe account scaffolding: EE remains the default production account.
// US secrets are optional; getStripe('us') fails closed when they are unset.

export type BillingAccount = 'ee' | 'us'

export const DEFAULT_BILLING_ACCOUNT: BillingAccount = 'ee'
export const BILLING_ACCOUNTS: readonly BillingAccount[] = ['ee', 'us']

export function normalizeBillingAccount(value: string | null | undefined): BillingAccount {
  const normalized = (value ?? '').trim().toLowerCase()
  if (normalized === 'us')
    return 'us'
  return DEFAULT_BILLING_ACCOUNT
}

export function getStripeSecretKey(c: Context, account: BillingAccount = DEFAULT_BILLING_ACCOUNT): string {
  if (account === 'us')
    return getEnv(c, 'STRIPE_SECRET_KEY_US')
  return getEnv(c, 'STRIPE_SECRET_KEY')
}

export function getStripeWebhookSecret(c: Context, account: BillingAccount = DEFAULT_BILLING_ACCOUNT): string {
  if (account === 'us')
    return getEnv(c, 'STRIPE_WEBHOOK_SECRET_US')
  return getEnv(c, 'STRIPE_WEBHOOK_SECRET')
}

export function isStripeSecretKeyConfigured(secretKey: string): boolean {
  const trimmed = secretKey.trim()
  if (!trimmed)
    return false
  return trimmed.startsWith('sk_') || trimmed.startsWith('rk_')
}

export function isStripeAccountConfigured(c: Context, account: BillingAccount = DEFAULT_BILLING_ACCOUNT): boolean {
  return isStripeSecretKeyConfigured(getStripeSecretKey(c, account))
}

export function getNewCustomersBillingAccount(c: Context): BillingAccount {
  const requested = normalizeBillingAccount(getEnv(c, 'STRIPE_NEW_CUSTOMERS_ACCOUNT'))
  if (requested === 'us' && isStripeAccountConfigured(c, 'us'))
    return 'us'
  return DEFAULT_BILLING_ACCOUNT
}

export async function resolveBillingAccount(c: Context, customerId: string): Promise<BillingAccount> {
  if (!customerId)
    return DEFAULT_BILLING_ACCOUNT

  const { data, error } = await supabaseAdmin(c)
    .from('stripe_info')
    .select('billing_account')
    .eq('customer_id', customerId)
    .maybeSingle()

  if (error)
    return DEFAULT_BILLING_ACCOUNT

  return normalizeBillingAccount(data?.billing_account)
}

export function assertStripeAccountConfigured(c: Context, account: BillingAccount): void {
  if (!isStripeAccountConfigured(c, account))
    throw simpleError(
      'stripe_account_not_configured',
      `Stripe billing account "${account}" is not configured`,
      { billing_account: account },
    )
}

export interface PlanStripeCatalogRow {
  stripe_id: string
  stripe_id_us?: string | null
  price_m_id: string
  price_y_id: string
  price_m_id_us?: string | null
  price_y_id_us?: string | null
  credit_id: string
  credit_id_us?: string | null
}

export function resolvePlanProductId(plan: Pick<PlanStripeCatalogRow, 'stripe_id' | 'stripe_id_us'>, account: BillingAccount): string {
  if (account === 'us' && plan.stripe_id_us)
    return plan.stripe_id_us
  return plan.stripe_id
}

export function resolvePlanPriceId(
  plan: Pick<PlanStripeCatalogRow, 'price_m_id' | 'price_y_id' | 'price_m_id_us' | 'price_y_id_us'>,
  account: BillingAccount,
  recurrence: string,
): string | null {
  if (account === 'us') {
    const usPriceId = recurrence === 'year' ? plan.price_y_id_us : plan.price_m_id_us
    if (usPriceId)
      return usPriceId
  }
  return recurrence === 'year' ? plan.price_y_id : plan.price_m_id
}

export function resolvePlanCreditId(plan: Pick<PlanStripeCatalogRow, 'credit_id' | 'credit_id_us'>, account: BillingAccount): string | null {
  if (account === 'us' && plan.credit_id_us)
    return plan.credit_id_us
  return plan.credit_id
}
