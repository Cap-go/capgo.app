import type Stripe from 'stripe'
import { simpleError } from './hono.ts'

export const BILLING_CURRENCY_KEY = 'capgo_billing_currency'

export async function liveSubscriptions(stripe: Stripe, customerId: string) {
  const result = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })
  if (result.has_more)
    throw simpleError('billing_currency_unavailable', 'Could not verify all subscriptions. Please retry.')
  return result.data.filter(subscription => !['canceled', 'incomplete_expired'].includes(subscription.status))
}

// A saved preference overrides Stripe's historical default only after all old subscriptions end.
// Read Stripe directly: a delayed database webhook must never unlock an active subscription.
export async function effectiveBillingCurrency(stripe: Stripe, customer: Stripe.Customer) {
  const preferred = customer.metadata?.[BILLING_CURRENCY_KEY]
  if (!preferred || !/^[a-z]{3}$/.test(preferred))
    return customer.currency?.toLowerCase() ?? null
  const subscriptions = await liveSubscriptions(stripe, customer.id)
  return subscriptions[0]?.currency ?? preferred
}
