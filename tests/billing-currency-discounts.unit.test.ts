import { expect, it, vi } from 'vitest'
import { currencyScheduleCancelAt, updateCurrencyDiscountSchedule } from '../supabase/functions/_backend/utils/billing_currency_discounts'

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
