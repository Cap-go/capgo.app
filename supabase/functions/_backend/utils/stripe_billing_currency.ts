import { currencyScheduleCancelAt, updateCurrencyDiscountSchedule } from './billing_currency_discounts.ts'
import { billingRequestOptions, expireBillingCheckouts, withBillingProfileLock } from './billing_profile_lock.ts'
import { getPlanPriceId } from './stripe_billing.ts'
import { CURRENCY_TRANSITION_KEY, CURRENCY_TRANSITION_END_KEY, previewCurrencyTransition } from './billing_currency_transition.ts'
import type { Context } from 'hono'
import type { BillingCurrencyState } from '../../shared/billing-profile.ts'
import type { InAppBillingContext } from './stripe_in_app.ts'
import { BILLING_CURRENCY_KEY, liveSubscriptions } from './billing_currency.ts'
import { simpleError } from './hono.ts'
import { authPrincipal, queryJson, queryJsonOne, withRlsContext } from './pg_rls.ts'
import { syncSubscriptionData } from './stripe.ts'
import { syncBillingProfile } from './stripe_billing_profile_sync.ts'

async function availableCurrencies(c: Context, ctx: InAppBillingContext) {
  const plans = await withRlsContext(c, authPrincipal(c), client => queryJson<{ stripe_id: string, stripe_id_us: string | null, price_m_id: string, price_y_id: string, price_m_id_us: string | null, price_y_id_us: string | null }>(client,
    'SELECT stripe_id, stripe_id_us, price_m_id, price_y_id, price_m_id_us, price_y_id_us FROM public.plans'))
  const ids = [...new Set(plans.flatMap(plan => ['month', 'year'].flatMap((interval) => {
    const stored = ctx.billingAccount === 'us' ? (interval === 'year' ? plan.price_y_id_us : plan.price_m_id_us) : (interval === 'year' ? plan.price_y_id : plan.price_m_id)
    return stored ? [getPlanPriceId(plan, ctx.billingAccount, interval)] : []
  })))]
  const prices = await Promise.all(ids.map(async (id) => {
    try {
      return await ctx.stripe.prices.retrieve(id, { expand: ['currency_options'] }, billingRequestOptions)
    }
    catch (error) {
      if ((error as { code?: string }).code === 'resource_missing')
        return null
      throw error
    }
  }))
  const sets = prices.filter(price => price?.active).flatMap(price => price ? [[price.currency, ...Object.keys(price.currency_options ?? {})]] : [])
  if (!sets.length)
    throw simpleError('billing_currency_unavailable', 'Could not load billing currencies. Please retry.')
  return sets[0].filter(currency => sets.every(set => set.includes(currency))).sort()
}

export async function getBillingCurrencyState(c: Context, ctx: InAppBillingContext): Promise<BillingCurrencyState> {
  const [customer, subscriptions, currencies] = await Promise.all([
    ctx.stripe.customers.retrieve(ctx.customerId), liveSubscriptions(ctx.stripe, ctx.customerId), availableCurrencies(c, ctx),
  ])
  if (customer.deleted)
    throw simpleError('no_customer', 'No customer')
  const subscription = subscriptions[0]
  const preferred = /^[a-z]{3}$/.test(customer.metadata?.[BILLING_CURRENCY_KEY] ?? '') ? customer.metadata[BILLING_CURRENCY_KEY] : null
  const eligibility = await withRlsContext(c, authPrincipal(c), client => queryJsonOne<{ trial: boolean, plan_name: string | null }>(client,
    `SELECT (s.trial_at::date > CURRENT_DATE AND s.status IS DISTINCT FROM 'succeeded') AS trial, p.name AS plan_name
     FROM public.stripe_info s LEFT JOIN public.plans p ON p.stripe_id = s.product_id OR p.stripe_id_us = s.product_id
     WHERE s.customer_id = $1`, [ctx.customerId]))
  const scheduledEnd = subscription ? await currencyScheduleCancelAt(ctx.stripe, subscription) : null
  return {
    regionalDiscountEligible: subscription?.status === 'trialing' || (!subscription && !!eligibility?.trial) || (!!subscription && eligibility?.plan_name?.toLowerCase() === 'solo'),
    currency: subscription?.currency ?? preferred ?? customer.currency ?? null,
    currencies,
    subscriptionId: subscription?.id ?? null,
    endsAt: subscription ? new Date((scheduledEnd ?? Math.max(...subscription.items.data.map(item => item.current_period_end))) * 1000).toISOString() : null,
    pendingCurrency: (subscription?.cancel_at_period_end || subscription?.cancel_at || scheduledEnd) ? subscription.metadata?.[CURRENCY_TRANSITION_KEY] || null : null,
  }
}

export async function changeBillingCurrency(c: Context, ctx: InAppBillingContext, value: unknown, confirmedSubscription: unknown, quoteId?: unknown) {
  const currencies = await availableCurrencies(c, ctx)
  if (typeof value !== 'string' || !currencies.includes(value))
    throw simpleError('invalid_currency', 'Choose an available billing currency')
  await withBillingProfileLock(c, ctx.billingAccount, ctx.customerId, async (assertHeld) => {
    const subscriptions = await liveSubscriptions(ctx.stripe, ctx.customerId)
    const subscription = subscriptions[0]
    if (subscriptions.length > 1 || (subscription && !['active', 'trialing'].includes(subscription.status)))
      throw simpleError('billing_currency_subscription', 'Resolve your outstanding subscription payment before changing currency.')
    if (subscription?.currency === value && subscription.metadata?.[CURRENCY_TRANSITION_KEY])
      throw simpleError('billing_currency_confirmation', 'Use Keep my plan to cancel the pending currency change.')
    if (subscription && subscription.currency !== value && confirmedSubscription !== subscription.id)
      throw simpleError('billing_currency_confirmation', 'Review and confirm the automatic currency change.')
    const schedules = await ctx.stripe.subscriptionSchedules.list({ customer: ctx.customerId, limit: 100 })
    if (schedules.has_more || schedules.data.some(schedule => ['not_started', 'active'].includes(schedule.status) && !schedule.metadata?.capgo_currency_replaces))
      throw simpleError('billing_currency_schedule', 'Cancel the scheduled trial plan in Billing first, then change currency here.')
    await expireBillingCheckouts(ctx.stripe, ctx.customerId, assertHeld)
    const latest = await liveSubscriptions(ctx.stripe, ctx.customerId)
    if (latest.length !== subscriptions.length || latest.some((item, index) => item.id !== subscriptions[index].id || item.currency !== subscriptions[index].currency))
      throw simpleError('billing_currency_quote_changed', 'A checkout completed. Review your current subscription and try again.')
    if (subscription && subscription.currency !== value) {
      const current = await ctx.stripe.subscriptions.retrieve(subscription.id, { expand: ['discounts.source.coupon.currency_options', 'items.data.discounts'] }, billingRequestOptions)
      if (!['active', 'trialing'].includes(current.status) || current.currency !== subscription.currency)
        throw simpleError('billing_currency_quote_changed', 'Review your current subscription and try again.')
      const preview = await previewCurrencyTransition(c, ctx, current, value)
      if (preview.quoteId !== quoteId)
        throw simpleError('billing_currency_quote_changed', 'Review the updated renewal price and confirm the currency change again.')
      const periodEnd = Math.max(...current.items.data.map(item => item.current_period_end))
      const scheduled = await updateCurrencyDiscountSchedule(ctx.stripe, current.id, true, assertHeld, periodEnd)
      await assertHeld()
      // An explicit date cannot silently move to another paid period during renewal.
      await ctx.stripe.subscriptions.update(current.id, { ...(scheduled ? {} : { cancel_at: periodEnd }), proration_behavior: 'none', metadata: { [CURRENCY_TRANSITION_KEY]: value, [CURRENCY_TRANSITION_END_KEY]: String(periodEnd) } }, billingRequestOptions)
      await syncSubscriptionData(c, ctx.customerId, current.id)
    }
    await assertHeld()
    await ctx.stripe.customers.update(ctx.customerId, { metadata: { [BILLING_CURRENCY_KEY]: value } }, billingRequestOptions)
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
  const subscription = await ctx.stripe.subscriptions.retrieve(subscriptions[0].id, { expand: ['discounts.source.coupon.currency_options', 'items.data.discounts'] }, billingRequestOptions)
  return previewCurrencyTransition(c, ctx, subscription, currency)
}
