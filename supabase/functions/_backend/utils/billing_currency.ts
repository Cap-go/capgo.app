import type Stripe from 'stripe'

export const BILLING_CURRENCY_KEY = 'capgo_billing_currency'

export async function liveSubscriptions(stripe: Stripe, customerId: string) {
  const subscriptions: Stripe.Subscription[] = []
  let cursor: string | undefined
  do {
    const page = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100, ...(cursor ? { starting_after: cursor } : {}) })
    subscriptions.push(...page.data.filter(subscription => !['canceled', 'incomplete_expired'].includes(subscription.status)))
    cursor = page.has_more ? page.data.at(-1)?.id : undefined
  } while (cursor)
  return subscriptions
}

// A saved preference overrides Stripe's historical default only after all old subscriptions end.
// Read Stripe directly: a delayed database webhook must never unlock an active subscription.
export async function effectiveBillingCurrency(stripe: Stripe, customer: Stripe.Customer) {
  const preferred = customer.metadata?.[BILLING_CURRENCY_KEY]
  const subscriptions = await liveSubscriptions(stripe, customer.id)
  return subscriptions[0]?.currency ?? (preferred && /^[a-z]{3}$/.test(preferred) ? preferred : customer.currency?.toLowerCase() ?? null)
}
