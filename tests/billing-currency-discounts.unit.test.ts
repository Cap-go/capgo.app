import { expect, it, vi } from 'vitest'
import { updateCurrencyDiscountSchedule } from '../supabase/functions/_backend/utils/billing_currency_discounts'

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
