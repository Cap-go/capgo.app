import type Stripe from 'stripe'
import { expect, it, vi } from 'vitest'
import { currencyScheduleCancelAt, replacementDiscounts, updateCurrencyDiscountSchedule } from '../supabase/functions/_backend/utils/billing_currency_discounts'

it.each([
  { kind: 'percentage', scope: 'subscription' },
  { kind: 'percentage', scope: 'item' },
  { kind: 'fixed', scope: 'subscription' },
  { kind: 'fixed', scope: 'item' },
])('loads omitted product restrictions before copying an expanded $kind $scope coupon', async ({ kind, scope }) => {
  const source = {
    id: 'coupon_plan_only', duration: 'forever',
    percent_off: kind === 'percentage' ? 25 : null,
    amount_off: kind === 'fixed' ? 1000 : null, currency: kind === 'fixed' ? 'usd' : null,
    // The subscription response includes amounts but not product restrictions.
    currency_options: kind === 'fixed' ? { eur: { amount_off: 900 } } : undefined,
  }
  const stripe = { coupons: {
    retrieve: vi.fn(async (id: string, params: Stripe.CouponRetrieveParams = {}) => {
      if (id !== source.id)
        throw Object.assign(new Error('No such coupon'), { code: 'resource_missing' })
      return { ...source, ...(params.expand?.includes('applies_to') ? { applies_to: { products: ['prod_plan'] } } : {}) }
    }),
    create: vi.fn(async (params: Stripe.CouponCreateParams) => params),
  } }
  const discount = {
    id: 'di_plan_only', end: null, source: { coupon: source },
    ...(scope === 'subscription' ? { subscription: 'sub_example' } : { subscription_item: 'si_example' }),
  } as Stripe.Discount
  await replacementDiscounts(stripe as any, [discount], 'eur', 1893456000, false)
  const params = stripe.coupons.create.mock.calls[0][0]
  expect(params.applies_to).toEqual({ products: ['prod_plan'] })
  expect(params.applies_to?.products).not.toContain('prod_extra_mau')
  expect(stripe.coupons.retrieve).toHaveBeenCalledWith(source.id, { expand: ['currency_options', 'applies_to'] }, expect.anything())
  if (kind === 'percentage')
    expect(params.percent_off).toBe(25)
  else
    expect(params).toMatchObject({ amount_off: 1000, currency: 'usd', currency_options: { eur: { amount_off: 900 } } })
})

it.each([
  { scope: 'subscription', finite: false, sourceForm: 'expanded' },
  { scope: 'subscription', finite: true, sourceForm: 'id' },
  { scope: 'item', finite: false, sourceForm: 'unexpanded' },
  { scope: 'item', finite: true, sourceForm: 'expanded' },
])('preserves fixed discount amounts through USD to EUR to USD: %j', async ({ scope, finite, sourceForm }) => {
  const startsAt = 1893456000
  const end = finite ? startsAt + 60 * 86400 : null
  const original: Stripe.Coupon = {
    id: 'coupon_original', currency: 'usd', amount_off: 1000, percent_off: null,
    currency_options: { eur: { amount_off: 900 }, gbp: { amount_off: 800 } },
    duration: finite ? 'repeating' : 'forever', name: 'Example offer', applies_to: { products: ['prod_example'] }, metadata: {},
    object: 'coupon', created: startsAt - 86400, duration_in_months: finite ? 2 : null,
    livemode: false, max_redemptions: null, redeem_by: null, times_redeemed: 1, valid: true,
  }
  const coupons = new Map([[original.id, original]])
  const withoutExpandedFields = (coupon: Stripe.Coupon) => {
    const { currency_options: _options, applies_to: _products, ...base } = coupon
    return base
  }
  const stripe = { coupons: {
    retrieve: vi.fn(async (id: string, params: Stripe.CouponRetrieveParams = {}) => {
      const coupon = coupons.get(id)
      if (!coupon)
        throw Object.assign(new Error('No such coupon'), { code: 'resource_missing' })
      const { currency_options, applies_to, ...base } = coupon
      return {
        ...base,
        ...(params.expand?.includes('currency_options') ? { currency_options } : {}),
        ...(params.expand?.includes('applies_to') ? { applies_to } : {}),
      }
    }),
    create: vi.fn(async (params: Stripe.CouponCreateParams) => {
      const coupon = { ...withoutExpandedFields(original), ...params, id: params.id!, duration_in_months: null } as Stripe.Coupon
      coupons.set(coupon.id, coupon)
      return withoutExpandedFields(coupon)
    }),
  } }
  const discount = {
    id: 'di_original', end,
    ...(scope === 'subscription' ? { subscription: 'sub_original' } : { subscription_item: 'si_original' }),
    source: { coupon: sourceForm === 'id' ? original.id : sourceForm === 'unexpanded' ? withoutExpandedFields(original) : original },
  } as Stripe.Discount
  const [first] = await replacementDiscounts(stripe as any, [discount], 'eur', startsAt, false)
  expect(first).toEqual({ params: { coupon: 'currency_di_original_eur' }, end })
  const copied = coupons.get('currency_di_original_eur')!
  const nextDiscount = {
    ...discount, id: 'di_replacement', end: null,
    source: { coupon: withoutExpandedFields(copied) },
  } as Stripe.Discount
  const [second] = await replacementDiscounts(stripe as any, [nextDiscount], 'usd', startsAt + 86400, false)
  expect(second).toEqual({ params: { coupon: 'currency_di_replacement_usd' }, end })
  for (const coupon of [copied, coupons.get('currency_di_replacement_usd')!]) {
    expect(coupon).toMatchObject({ currency: 'usd', amount_off: 1000, currency_options: original.currency_options, applies_to: original.applies_to })
    expect(coupon.metadata?.capgo_discount_end ?? null).toBe(end ? String(end) : null)
  }
  // Repeating the preview reuses the prepared coupon instead of creating another.
  expect(await replacementDiscounts(stripe as any, [nextDiscount], 'usd', startsAt + 86400, false)).toEqual([second])
  expect(stripe.coupons.create).toHaveBeenCalledTimes(2)
  await expect(replacementDiscounts(stripe as any, [nextDiscount], 'jpy', startsAt + 86400, false)).rejects.toMatchObject({ cause: { error: 'billing_discount_currency' } })
  expect(stripe.coupons.create).toHaveBeenCalledTimes(2)
})

it('does not create an unrestricted coupon when loading its original terms fails', async () => {
  const stripe = { coupons: {
    retrieve: vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('No prepared coupon'), { code: 'resource_missing' }))
      .mockRejectedValueOnce(new Error('Original coupon unavailable')),
    create: vi.fn(),
  } }
  const discount = {
    id: 'di_plan_only', end: null, subscription: 'sub_example',
    source: { coupon: { id: 'coupon_plan_only', percent_off: 25, duration: 'forever' } },
  } as Stripe.Discount
  await expect(replacementDiscounts(stripe as any, [discount], 'eur', 1893456000, false)).rejects.toThrow('Original coupon unavailable')
  expect(stripe.coupons.create).not.toHaveBeenCalled()
})

it.each([true, false])('preserves expiry and billing anchor when cancel is %s on a replacement schedule', async (cancel) => {
  const now = Math.floor(Date.now() / 1000)
  const end = now + 40 * 86400
  const periodEnd = now + 20 * 86400
  const stripe = {
    subscriptions: { retrieve: vi.fn(async () => ({
      schedule: 'sub_sched_example', currency: 'usd',
      discounts: [{ id: 'di_current', end: null, source: { coupon: { metadata: { capgo_discount_end: String(end) } } } }],
      items: { data: [{ price: { id: 'price_current' }, quantity: 2, current_period_end: periodEnd, discounts: [] }] },
    })) },
    subscriptionSchedules: {
      retrieve: vi.fn(async () => ({ status: 'active', current_phase: { start_date: now - 86400 }, metadata: { capgo_currency_replaces: 'sub_previous' } })),
      update: vi.fn(),
    },
  }
  expect(await updateCurrencyDiscountSchedule(stripe as any, 'sub_current', cancel)).toBe(true)
  const [id, update] = stripe.subscriptionSchedules.update.mock.calls[0]
  expect(id).toBe('sub_sched_example')
  expect(update).toMatchObject({ end_behavior: cancel ? 'cancel' : 'release', proration_behavior: 'none' })
  expect(update.phases[0]).toMatchObject({ start_date: now - 86400, end_date: cancel ? periodEnd : end, billing_cycle_anchor: 'automatic', discounts: [{ discount: 'di_current' }] })
  if (!cancel)
    expect(update.phases[1].discounts).toEqual([])
})

it.each([
  { status: 'active', subscription: 'sub_other', end_behavior: 'cancel', metadata: { capgo_currency_replaces: 'sub_old' } },
  { status: 'active', subscription: 'sub_example', end_behavior: 'cancel', metadata: {} },
  { status: 'released', subscription: 'sub_example', end_behavior: 'cancel', metadata: { capgo_currency_replaces: 'sub_old' } },
])('does not infer cancellation from a foreign or inactive schedule: %j', async (schedule) => {
  const stripe = { subscriptionSchedules: { retrieve: vi.fn(async () => ({ ...schedule, phases: [{ end_date: 1893456000 }] })) } }
  expect(await currencyScheduleCancelAt(stripe as any, { id: 'sub_example', schedule: 'sched_example' } as any)).toBeNull()
})

it('refuses to rebuild a discount schedule if its paid period renewed after confirmation', async () => {
  const stripe = {
    subscriptions: { retrieve: vi.fn(async () => ({ schedule: 'sched_owned', items: { data: [{ current_period_end: 1896134400 }] } })) },
    subscriptionSchedules: { retrieve: vi.fn(async () => ({ status: 'active', current_phase: { start_date: 1893456000 }, metadata: { capgo_currency_replaces: 'sub_old' } })), update: vi.fn() },
  }
  await expect(updateCurrencyDiscountSchedule(stripe as any, 'sub_example', true, async () => {}, { expectedPeriodEnd: 1893456000 })).rejects.toThrow('updated renewal date')
  expect(stripe.subscriptionSchedules.update).not.toHaveBeenCalled()
})
