import type { Context } from 'hono'
import type Stripe from 'stripe'
import type { PriceTier } from './country_price_tier.ts'
import type { BillingAccount } from './stripe_billing.ts'
import { currencyForCountry } from './country_currency.ts'
import { FULL_PRICE_TIER, isCheaperTier, isPriceTier, priceTierForCountries, priceTierForCountry } from './country_price_tier.ts'
import { cloudlog } from './logging.ts'
import { findPlanByProductId, getPlanPriceId, getRegionalPlanPriceId, getRequestCountry } from './stripe_billing.ts'

// Regional discount prices carry their tier in Stripe metadata (capgo_tier); full prices have none or p100.
const PRICE_TIER_METADATA_KEY = 'capgo_tier'

export interface CustomerBilling {
  // Currency Stripe already bills the customer in; null means any currency is allowed.
  currency: string | null
  // Countries of the billing address and the default payment method.
  countries: string[]
}

export function paymentMethodCountry(paymentMethod: string | Stripe.PaymentMethod | null | undefined): string | null {
  if (!paymentMethod || typeof paymentMethod === 'string')
    return null
  return paymentMethod.card?.country ?? paymentMethod.sepa_debit?.country ?? paymentMethod.billing_details?.address?.country ?? null
}

export async function getCustomerBilling(stripe: Stripe, customerId: string): Promise<CustomerBilling> {
  const customer = await stripe.customers.retrieve(customerId, { expand: ['invoice_settings.default_payment_method'] })
  if (customer.deleted)
    return { currency: null, countries: [] }
  const countries = [customer.address?.country, paymentMethodCountry(customer.invoice_settings?.default_payment_method)]
  return {
    currency: customer.currency?.toLowerCase() ?? null,
    countries: countries.filter((country): country is string => !!country),
  }
}

// Tier offered to this request: the visitor's country plus what Stripe already knows about the customer.
export function getRequestPriceTier(c: Context, customerCountries: string[] = []): PriceTier {
  return priceTierForCountries([getRequestCountry(c), ...customerCountries])
}

// A regional price is set for one market, so it is only sold in that country's currency, or in USD where
// Stripe does not sell that currency (null soldCurrencies: only for countries without a known currency).
export function isRegionalCurrency(countries: Array<string | null | undefined>, tier: PriceTier, currency: string, soldCurrencies: string[] | null): boolean {
  if (tier === FULL_PRICE_TIER)
    return true
  return countries.some((country) => {
    if (!country || priceTierForCountry(country) !== tier)
      return false
    const local = currencyForCountry(country)
    if (local === currency)
      return true
    return currency === 'usd' && (!local || (!!soldCurrencies && !soldCurrencies.includes(local)))
  })
}

// The tier of these countries, or the full price when billed in a currency of another market.
export function priceTierForCurrency(countries: Array<string | null | undefined>, currency: string, soldCurrencies: string[] | null): PriceTier {
  const tier = priceTierForCountries(countries)
  return isRegionalCurrency(countries, tier, currency, soldCurrencies) ? tier : FULL_PRICE_TIER
}

export function getPriceTier(price: Pick<Stripe.Price, 'metadata'>): PriceTier {
  const tier = price.metadata?.[PRICE_TIER_METADATA_KEY]
  return isPriceTier(tier) ? tier : FULL_PRICE_TIER
}

function findRegionalItem(subscription: Stripe.Subscription) {
  return subscription.items.data.find(({ price }) => price.recurring?.usage_type === 'licensed' && getPriceTier(price) !== FULL_PRICE_TIER)
}

// A regional discount is only kept when the card paying it and the billing address are from that region,
// and the subscription is billed in that region's currency: otherwise the subscription moves to the price
// of the most expensive of those countries and the difference is invoiced now. Nothing known about the
// buyer means the full price.
export async function enforceRegionalPrice(c: Context, stripe: Stripe, billingAccount: BillingAccount, eventSubscription: Stripe.Subscription): Promise<boolean> {
  if (!findRegionalItem(eventSubscription))
    return false
  // Webhooks can arrive out of order: decide on the live subscription, not the event's snapshot.
  const subscription = await stripe.subscriptions.retrieve(eventSubscription.id)
  // Incomplete checkouts have not been paid: check once the payment went through.
  if (!['active', 'trialing', 'past_due'].includes(subscription.status))
    return false
  // Stripe rejects price changes on schedule-managed subscriptions (trial plans): check again once released.
  if (subscription.schedule)
    return false
  const item = findRegionalItem(subscription)
  if (!item)
    return false
  const soldTier = getPriceTier(item.price)
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
  const subscriptionPaymentMethod = subscription.default_payment_method
  const [billing, paymentMethod] = await Promise.all([
    getCustomerBilling(stripe, customerId),
    typeof subscriptionPaymentMethod === 'string' ? stripe.paymentMethods.retrieve(subscriptionPaymentMethod) : subscriptionPaymentMethod,
  ])
  const countries = [paymentMethodCountry(paymentMethod), ...billing.countries]
  // Billed in another market's currency (an org pinned to USD, a buyer who picked USD): the full price.
  const soldPrice = await stripe.prices.retrieve(item.price.id, { expand: ['currency_options'] })
  const requiredTier = priceTierForCurrency(countries, subscription.currency, Object.keys(soldPrice.currency_options ?? {}))
  if (!isCheaperTier(soldTier, requiredTier))
    return false

  const productId = typeof item.price.product === 'string' ? item.price.product : item.price.product.id
  const { data: plan } = await findPlanByProductId(c, productId)
  if (!plan)
    throw new Error(`No plan for regional price product ${productId}`)
  const interval = item.price.recurring?.interval === 'year' ? 'year' : 'month'
  const priceId = getRegionalPlanPriceId(plan.regional_price_ids, requiredTier, billingAccount, interval) ?? getPlanPriceId(plan, billingAccount, interval)
  if (!priceId || priceId === item.price.id)
    return false
  await stripe.subscriptions.update(subscription.id, {
    items: [{ id: item.id, price: priceId }],
    proration_behavior: 'always_invoice',
  })
  cloudlog({ requestId: c.get('requestId'), message: 'Regional price corrected to the buyer country', subscriptionId: subscription.id, soldTier, requiredTier, countries, priceId })
  return true
}

// A billing address or default card change can disqualify a discount: check every subscription of the customer.
export async function enforceRegionalPriceForCustomer(c: Context, stripe: Stripe, billingAccount: BillingAccount, customerId: string): Promise<boolean> {
  const subscriptions = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })
  let corrected = false
  for (const subscription of subscriptions.data) {
    if (await enforceRegionalPrice(c, stripe, billingAccount, subscription))
      corrected = true
  }
  return corrected
}
