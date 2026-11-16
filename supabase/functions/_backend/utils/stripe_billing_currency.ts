import { CURRENCY_TRANSITION_KEY, CURRENCY_TRANSITION_END_KEY, previewCurrencyTransition } from './billing_currency_transition.ts'
import type { Context } from 'hono'
import type { BillingCurrencyState } from '../../shared/billing-profile.ts'
import type { InAppBillingContext } from './stripe_in_app.ts'
import { BILLING_CURRENCY_KEY, liveSubscriptions } from './billing_currency.ts'
import { simpleError } from './hono.ts'
import { authPrincipal, queryJson, queryJsonOne, servicePrincipal, withRlsContext } from './pg_rls.ts'
import { syncSubscriptionData } from './stripe.ts'
import { syncBillingProfile } from './stripe_billing_profile_sync.ts'

async function availableCurrencies(c: Context, ctx: InAppBillingContext) {
  const plans = await withRlsContext(c, authPrincipal(c), client => queryJson<{ price_m_id: string, price_y_id: string, price_m_id_us: string | null, price_y_id_us: string | null }>(client,
    'SELECT price_m_id, price_y_id, price_m_id_us, price_y_id_us FROM public.plans'))
  const ids = [...new Set(plans.flatMap(plan => ctx.billingAccount === 'us' ? [plan.price_m_id_us, plan.price_y_id_us] : [plan.price_m_id, plan.price_y_id]))]
  if (!ids.length || ids.some(id => !id))
    throw simpleError('billing_currency_unavailable', 'Could not load billing currencies. Please retry.')
  const prices = await Promise.all(ids.map(id => ctx.stripe.prices.retrieve(id!, { expand: ['currency_options'] })))
  const sets = prices.map(price => price.active ? [price.currency, ...Object.keys(price.currency_options ?? {})] : [])
  return sets[0].filter(currency => sets.every(set => set.includes(currency))).sort()
}

export async function getBillingCurrencyState(c: Context, ctx: InAppBillingContext): Promise<BillingCurrencyState> {
  const [customer, subscriptions, currencies] = await Promise.all([
    ctx.stripe.customers.retrieve(ctx.customerId), liveSubscriptions(ctx.stripe, ctx.customerId), availableCurrencies(c, ctx),
  ])
  if (customer.deleted)
    throw simpleError('no_customer', 'No customer')
  const subscription = subscriptions[0]
  const preferred = customer.metadata?.[BILLING_CURRENCY_KEY] || null
  const eligibility = await withRlsContext(c, authPrincipal(c), client => queryJsonOne<{ trial: boolean, plan_name: string | null }>(client,
    `SELECT (s.trial_at::date > CURRENT_DATE AND s.status IS DISTINCT FROM 'succeeded') AS trial, p.name AS plan_name
     FROM public.stripe_info s LEFT JOIN public.plans p ON p.stripe_id = s.product_id OR p.stripe_id_us = s.product_id
     WHERE s.customer_id = $1`, [ctx.customerId]))
  return {
    regionalDiscountEligible: subscription?.status === 'trialing' || (!subscription && !!eligibility?.trial) || (!!subscription && eligibility?.plan_name?.toLowerCase() === 'solo'),
    currency: subscription?.currency ?? preferred ?? customer.currency ?? null,
    currencies,
    subscriptionId: subscription?.id ?? null,
    endsAt: subscription ? new Date(Math.max(...subscription.items.data.map(item => item.current_period_end)) * 1000).toISOString() : null,
    pendingCurrency: subscription?.cancel_at_period_end ? subscription.metadata?.[CURRENCY_TRANSITION_KEY] || null : null,
  }
}

export async function changeBillingCurrency(c: Context, ctx: InAppBillingContext, value: unknown, confirmedSubscription: unknown, quoteId?: unknown) {
  const currencies = await availableCurrencies(c, ctx)
  if (typeof value !== 'string' || !currencies.includes(value))
    throw simpleError('invalid_currency', 'Choose an available billing currency')
  await withRlsContext(c, servicePrincipal, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`billing-profile:${ctx.billingAccount}:${ctx.customerId}`])
    const subscriptions = await liveSubscriptions(ctx.stripe, ctx.customerId)
    const subscription = subscriptions[0]
    if (subscriptions.length > 1 || (subscription && !['active', 'trialing'].includes(subscription.status)))
      throw simpleError('billing_currency_subscription', 'Resolve your outstanding subscription payment before changing currency.')
    if (subscription && subscription.currency !== value && confirmedSubscription !== subscription.id)
      throw simpleError('billing_currency_confirmation', 'Review and confirm the automatic currency change.')
    const preview = subscription && subscription.currency !== value ? await previewCurrencyTransition(c, ctx, subscription, value) : null
    if (preview && preview.quoteId !== quoteId)
      throw simpleError('billing_currency_quote_changed', 'Review the updated renewal price and confirm the currency change again.')
    const schedules = await ctx.stripe.subscriptionSchedules.list({ customer: ctx.customerId, limit: 100 })
    if (schedules.has_more || schedules.data.some(schedule => ['not_started', 'active'].includes(schedule.status)))
      throw simpleError('billing_currency_schedule', 'Cancel the scheduled trial plan in Billing first, then change currency here.')
    // Expire unpaid sessions so a stale checkout cannot start a subscription in the old currency.
    const sessions = await ctx.stripe.checkout.sessions.list({ customer: ctx.customerId, status: 'open', limit: 100 })
    if (sessions.has_more)
      throw simpleError('billing_currency_sessions', 'Too many open checkouts. Please retry once they expire.')
    for (const session of sessions.data)
      await ctx.stripe.checkout.sessions.expire(session.id)
    if (subscription && subscription.currency !== value) {
      await ctx.stripe.subscriptions.update(subscription.id, { cancel_at_period_end: true, proration_behavior: 'none', metadata: { [CURRENCY_TRANSITION_KEY]: value, [CURRENCY_TRANSITION_END_KEY]: String(Math.max(...subscription.items.data.map(item => item.current_period_end))) } })
      await syncSubscriptionData(c, ctx.customerId, subscription.id)
    }
    await ctx.stripe.customers.update(ctx.customerId, { metadata: { [BILLING_CURRENCY_KEY]: value } })
  })
  // Separate transaction: sync uses the same lock and reads current Stripe state for retry safety.
  await syncBillingProfile(c, ctx)
  return getBillingCurrencyState(c, ctx)
}

export async function getCurrencyTransitionPreview(c: Context, ctx: InAppBillingContext, currency: unknown) {
  if (typeof currency !== 'string' || !(await availableCurrencies(c, ctx)).includes(currency))
    throw simpleError('invalid_currency', 'Choose an available billing currency')
  const subscriptions = await liveSubscriptions(ctx.stripe, ctx.customerId)
  if (subscriptions.length !== 1)
    throw simpleError('billing_currency_subscription', 'Refresh your billing settings and try again')
  return previewCurrencyTransition(c, ctx, subscriptions[0], currency)
}
