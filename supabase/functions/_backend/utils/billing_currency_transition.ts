import type { Context } from 'hono'
import type Stripe from 'stripe'
import type { BillingCurrencyPreview } from '../../shared/billing-profile.ts'
import type { InAppBillingContext } from './stripe_in_app.ts'
import { BILLING_CURRENCY_KEY } from './billing_currency.ts'
import { currencyForCountry } from './country_currency.ts'
import { FULL_PRICE_TIER } from './country_price_tier.ts'
import { simpleError } from './hono.ts'
import { servicePrincipal, withRlsContext } from './pg_rls.ts'
import { getPriceTier, paymentMethodCountry } from './regional_price.ts'
import { getCheckoutPlanPrice } from './stripe.ts'

export const CURRENCY_TRANSITION_KEY = 'capgo_currency_transition'
export const CURRENCY_TRANSITION_END_KEY = 'capgo_currency_transition_end'
export const CURRENCY_REPLACES_KEY = 'capgo_currency_replaces'
export const clearCurrencyTransition = { [CURRENCY_TRANSITION_KEY]: '', [CURRENCY_TRANSITION_END_KEY]: '' }

const id = (value: { id: string } | string | null | undefined) => typeof value === 'string' ? value : value?.id

async function replacementParams(c: Context, ctx: InAppBillingContext, subscription: Stripe.Subscription, currency: string): Promise<Stripe.SubscriptionCreateParams> {
  const customer = await ctx.stripe.customers.retrieve(ctx.customerId, { expand: ['invoice_settings.default_payment_method'] })
  if (customer.deleted)
    throw simpleError('no_customer', 'No customer')
  const paymentMethodId = id(subscription.default_payment_method) ?? id(customer.invoice_settings.default_payment_method)
  const paymentMethod = paymentMethodId ? await ctx.stripe.paymentMethods.retrieve(paymentMethodId) : null
  const country = customer.address?.country
  const eligible = !!country && paymentMethodCountry(paymentMethod) === country && currencyForCountry(country) === currency
  const items = await Promise.all(subscription.items.data.map(async (item) => {
    let price: Stripe.Price = await ctx.stripe.prices.retrieve(item.price.id, { expand: ['currency_options'] })
    if (getPriceTier(price) !== FULL_PRICE_TIER && !eligible) {
      const productId = id(price.product)!
      const full = await getCheckoutPlanPrice(c, productId, price.recurring?.interval === 'year' ? 'year' : 'month', ctx.billingAccount, FULL_PRICE_TIER)
      if (!full)
        throw simpleError('invalid_currency', 'Could not load this plan in the selected currency')
      price = full
    }
    if (!price.active || (price.currency !== currency && !price.currency_options?.[currency]))
      throw simpleError('invalid_currency', 'This plan is not sold in the selected currency')
    return { price: price.id, ...(item.quantity == null ? {} : { quantity: item.quantity }), ...(item.tax_rates?.length ? { tax_rates: item.tax_rates.map(rate => rate.id) } : {}), ...(item.discounts?.length ? { discounts: item.discounts.map(discount => ({ discount: id(discount)! })) } : {}) }
  }))
  const metadata = Object.fromEntries(Object.entries(subscription.metadata).filter(([key]) => !key.startsWith('capgo_currency_') && !key.startsWith('capgo_trial_')))
  return {
    customer: ctx.customerId, currency, items,
    collection_method: subscription.collection_method,
    ...(subscription.collection_method === 'send_invoice' ? { days_until_due: subscription.days_until_due ?? 30 } : { payment_behavior: 'allow_incomplete', off_session: true }),
    ...(paymentMethodId ? { default_payment_method: paymentMethodId } : {}),
    ...(subscription.default_source ? { default_source: id(subscription.default_source) } : {}),
    automatic_tax: { enabled: subscription.automatic_tax.enabled },
    ...(subscription.default_tax_rates?.length ? { default_tax_rates: subscription.default_tax_rates.map(rate => rate.id) } : {}),
    // Reuse the existing discount, preserving its expiration instead of restarting a coupon.
    discounts: subscription.discounts.map(discount => ({ discount: id(discount)! })),
    proration_behavior: 'none',
    metadata: { ...metadata, [CURRENCY_REPLACES_KEY]: subscription.id },
  }
}

export async function previewCurrencyTransition(c: Context, ctx: InAppBillingContext, subscription: Stripe.Subscription, currency: string): Promise<BillingCurrencyPreview> {
  const params = await replacementParams(c, ctx, subscription, currency)
  const endsAt = Math.max(...subscription.items.data.map(item => item.current_period_end))
  const invoice = await ctx.stripe.invoices.createPreview({
    customer: ctx.customerId, currency, automatic_tax: params.automatic_tax, discounts: params.discounts,
    subscription_details: { start_date: endsAt, items: params.items, default_tax_rates: params.default_tax_rates, proration_behavior: 'none' },
  })
  const payload = JSON.stringify({ subscription: subscription.id, params, amount: invoice.total, endsAt })
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return {
    currency, amount: invoice.total, subscriptionId: subscription.id,
    interval: subscription.items.data[0].price.recurring?.interval === 'year' ? 'year' : 'month',
    quoteId: Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join(''),
  }
}

// Called only after webhook signature, customer ownership and billing-account validation.
// Run before cancellation event deduplication: a failed replacement must remain retryable.
export async function completeCurrencyTransition(c: Context, ctx: InAppBillingContext & { currentSubscriptionId: string | null }, eventSubscription: Stripe.Subscription): Promise<boolean> {
  if (!eventSubscription.metadata?.[CURRENCY_TRANSITION_KEY])
    return false
  return withRlsContext(c, servicePrincipal, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`billing-profile:${ctx.billingAccount}:${ctx.customerId}`])
    const subscription = await ctx.stripe.subscriptions.retrieve(eventSubscription.id)
    const currency = subscription.metadata[CURRENCY_TRANSITION_KEY]
    const end = Number(subscription.metadata[CURRENCY_TRANSITION_END_KEY])
    if (id(subscription.customer) !== ctx.customerId || subscription.status !== 'canceled' || !/^[a-z]{3}$/.test(currency ?? '') || !end || !subscription.ended_at || subscription.ended_at < end || ['payment_failed', 'payment_disputed'].includes(subscription.cancellation_details?.reason ?? ''))
      return false
    // Durable deduplication survives Stripe's 24-hour idempotency-key retention and lost responses.
    let cursor: string | undefined
    let existing: Stripe.Subscription | undefined
    let anotherLive = false
    do {
      const page = await ctx.stripe.subscriptions.list({ customer: ctx.customerId, status: 'all', limit: 100, ...(cursor ? { starting_after: cursor } : {}) })
      existing ??= page.data.find(item => item.metadata[CURRENCY_REPLACES_KEY] === subscription.id)
      anotherLive ||= page.data.some(item => item.id !== subscription.id && !['canceled', 'incomplete_expired'].includes(item.status))
      cursor = page.has_more ? page.data.at(-1)?.id : undefined
    } while (cursor && !existing)
    if (existing)
      return true
    // Never add a second paid subscription if a different checkout already replaced the old one.
    if (anotherLive || ctx.currentSubscriptionId !== subscription.id)
      return false
    const customer = await ctx.stripe.customers.retrieve(ctx.customerId)
    if (customer.deleted)
      return false
    const params = await replacementParams(c, ctx, subscription, currency)
    // The subscription marker is the confirmed intent; a failed preference sync must not lose it.
    await ctx.stripe.customers.update(ctx.customerId, { metadata: { [BILLING_CURRENCY_KEY]: currency } })
    await ctx.stripe.subscriptions.create(params, { idempotencyKey: `currency-replacement:${subscription.id}` })
    // The replacement's normal created/invoice webhooks synchronize Capgo and handle failed payments.
    // Do not emit churn or overwrite that new subscription with the old cancellation snapshot.
    return true
  })
}
