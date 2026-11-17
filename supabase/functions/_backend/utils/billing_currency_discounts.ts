import type Stripe from 'stripe'
import { billingRequestOptions } from './billing_profile_lock.ts'
import { simpleError } from './hono.ts'

export interface ReplacementDiscount {
  params: { discount: string } | { coupon: string }
  end: number | null
}

// Old subscription/item discounts cannot be attached to a sibling. Copy their
// economic terms to an internal coupon; schedule phases retain the original end.
// Preparing a preview can create this idempotent coupon, but never a charge.
export async function replacementDiscounts(stripe: Stripe, discounts: Array<string | Stripe.Discount>, currency: string, startsAt: number, wasTrial: boolean): Promise<ReplacementDiscount[]> {
  const result: ReplacementDiscount[] = []
  for (const discount of discounts) {
    if (typeof discount === 'string')
      throw simpleError('billing_discount_unavailable', 'Could not load the current discount. Please retry.')
    if (!discount.subscription && !discount.subscription_item) {
      if (!discount.end || discount.end > startsAt)
        result.push({ params: { discount: discount.id }, end: discount.end })
      continue
    }
    const source = discount.source.coupon
    const coupon = typeof source === 'string' ? await stripe.coupons.retrieve(source, { expand: ['currency_options'] }, billingRequestOptions) : source
    if (!coupon)
      throw simpleError('billing_discount_unavailable', 'Could not load the current discount. Please retry.')
    const end = Number(coupon.metadata?.capgo_discount_end) || discount.end
    if (end && end <= startsAt)
      continue
    // A once-only offer already paid on the old subscription must not renew.
    if (coupon.duration === 'once' && !wasTrial)
      continue
    const couponId = `currency_${discount.id}_${currency}`
    let copied: Stripe.Coupon | undefined
    try {
      copied = await stripe.coupons.retrieve(couponId, {}, billingRequestOptions)
    }
    catch (error) {
      if ((error as { code?: string }).code !== 'resource_missing')
        throw error
    }
    if (!copied) {
      const amount = coupon.currency === currency ? coupon.amount_off : coupon.currency_options?.[currency]?.amount_off
      if (!coupon.percent_off && !amount)
        throw simpleError('billing_discount_currency', 'This discount is not available in the selected currency.')
      copied = await stripe.coupons.create({
        id: couponId,
        duration: coupon.duration === 'once' ? 'once' : 'forever',
        ...(coupon.name ? { name: coupon.name } : {}),
        ...(coupon.percent_off ? { percent_off: coupon.percent_off } : { amount_off: amount!, currency }),
        ...(coupon.applies_to ? { applies_to: coupon.applies_to } : {}),
        metadata: { capgo_source_discount: discount.id, ...(end ? { capgo_discount_end: String(end) } : {}) },
      }, { ...billingRequestOptions, idempotencyKey: couponId })
    }
    result.push({ params: { coupon: copied.id }, end })
  }
  return result
}

// Keep cancellation/resume self-service while an automatic replacement's discount
// schedule is still active. Rebuild only our own schedule, preserving the invoice
// anchor and original discount expiry instead of releasing an indefinite coupon.
export async function updateCurrencyDiscountSchedule(stripe: Stripe, subscriptionId: string, cancel: boolean, assertHeld: () => Promise<void> = async () => {}, options: { expectedPeriodEnd?: number, metadata?: Stripe.MetadataParam } = {}): Promise<boolean> {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['discounts.source.coupon', 'items.data.discounts'] }, billingRequestOptions)
  const scheduleId = typeof subscription.schedule === 'string' ? subscription.schedule : subscription.schedule?.id
  if (!scheduleId)
    return false
  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId, {}, billingRequestOptions)
  if (!schedule.metadata?.capgo_currency_replaces || schedule.status !== 'active' || !schedule.current_phase)
    return false
  const now = Math.floor(Date.now() / 1000)
  const periodEnd = Math.max(...subscription.items.data.map(item => item.current_period_end))
  if (options.expectedPeriodEnd !== undefined && periodEnd !== options.expectedPeriodEnd)
    throw simpleError('billing_currency_quote_changed', 'Review the updated renewal date and confirm the currency change again.')
  const describe = async (discounts: Array<string | Stripe.Discount>) => Promise.all(discounts.map(async (discount) => {
    if (typeof discount === 'string')
      throw simpleError('billing_discount_unavailable', 'Could not load the current discount. Please retry.')
    const source = discount.source.coupon
    const coupon = typeof source === 'string' ? await stripe.coupons.retrieve(source, {}, billingRequestOptions) : source
    return { params: { discount: discount.id }, end: Number(coupon?.metadata?.capgo_discount_end) || discount.end }
  }))
  const discounts = await describe(subscription.discounts)
  const itemDiscounts = await Promise.all(subscription.items.data.map(item => describe(item.discounts ?? [])))
  const ends = [...new Set([...discounts, ...itemDiscounts.flat()].flatMap(discount => discount.end && discount.end > now && (!cancel || discount.end < periodEnd) ? [discount.end] : []))].sort((a, b) => a - b)
  const boundaries = [...ends, cancel ? periodEnd : null]
  const phases: Stripe.SubscriptionScheduleUpdateParams.Phase[] = boundaries.map((end, index) => {
    const start = index ? ends[index - 1] : now
    const active = (discount: { end: number | null }) => !discount.end || discount.end > start
    return {
      ...(index === 0 ? { start_date: schedule.current_phase!.start_date } : {}),
      ...(end ? { end_date: end } : { duration: { interval: 'month', interval_count: 1 } }),
      currency: subscription.currency, billing_cycle_anchor: 'automatic', proration_behavior: 'none',
      // Updating the active phase updates the subscription too. Save its intent
      // with cancellation in one Stripe write, and retain it across future phases.
      ...(options.metadata ? { metadata: { ...subscription.metadata, ...options.metadata } } : {}),
      default_tax_rates: subscription.default_tax_rates?.map(rate => rate.id),
      discounts: discounts.filter(active).map(discount => discount.params),
      items: subscription.items.data.map((item, itemIndex) => ({
        price: item.price.id, ...(item.quantity == null ? {} : { quantity: item.quantity }),
        tax_rates: item.tax_rates?.map(rate => rate.id),
        discounts: itemDiscounts[itemIndex].filter(active).map(discount => discount.params),
      })),
    }
  })
  await assertHeld()
  await stripe.subscriptionSchedules.update(scheduleId, { end_behavior: cancel ? 'cancel' : 'release', phases, proration_behavior: 'none' }, billingRequestOptions)
  return true
}

// Stripe only mirrors a schedule cancellation onto cancel_at in its final phase.
export async function currencyScheduleCancelAt(stripe: Stripe, subscription: Stripe.Subscription): Promise<number | null> {
  const scheduleId = typeof subscription.schedule === 'string' ? subscription.schedule : subscription.schedule?.id
  if (!scheduleId)
    return null
  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId, {}, billingRequestOptions)
  const owner = typeof schedule.subscription === 'string' ? schedule.subscription : schedule.subscription?.id
  if (!schedule.metadata?.capgo_currency_replaces || schedule.status !== 'active' || schedule.end_behavior !== 'cancel' || owner !== subscription.id)
    return null
  return schedule.phases.at(-1)?.end_date ?? null
}
