import type Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { creditsForMonthlyAmount, getSaveableMonthlyAmount, offerTypeFor } from '../supabase/functions/_backend/utils/cancel_save_offer.ts'

function item(unitAmount: number, interval: 'month' | 'year' = 'month', options: { quantity?: number, usageType?: 'licensed' | 'metered', intervalCount?: number } = {}) {
  return {
    quantity: options.quantity ?? 1,
    price: {
      unit_amount: unitAmount,
      recurring: { interval, interval_count: options.intervalCount ?? 1, usage_type: options.usageType ?? 'licensed' },
    },
  }
}

function subscription(overrides: Partial<Record<string, unknown>> = {}, items = [item(2900)]) {
  return {
    status: 'active',
    cancel_at_period_end: false,
    cancel_at: null,
    discounts: [],
    currency: 'usd',
    items: { data: items },
    ...overrides,
  } as unknown as Stripe.Subscription
}

describe('getSaveableMonthlyAmount', () => {
  it('returns the licensed monthly price of an active plan', () => {
    expect(getSaveableMonthlyAmount(subscription({}, [item(2900, 'month', { quantity: 2 }), item(0, 'month', { usageType: 'metered' })])))
      .toEqual({ amount: 5800, currency: 'usd' })
  })

  it('skips subscriptions that cannot take the discount', () => {
    expect(getSaveableMonthlyAmount(subscription({ status: 'trialing' }))).toBeNull()
    expect(getSaveableMonthlyAmount(subscription({ status: 'past_due' }))).toBeNull()
    expect(getSaveableMonthlyAmount(subscription({ cancel_at_period_end: true }))).toBeNull()
    expect(getSaveableMonthlyAmount(subscription({ cancel_at: 1_900_000_000 }))).toBeNull()
    expect(getSaveableMonthlyAmount(subscription({ discounts: ['di_existing'] }))).toBeNull()
    expect(getSaveableMonthlyAmount(subscription({}, [item(29000, 'year')]))).toBeNull()
    expect(getSaveableMonthlyAmount(subscription({}, [item(8700, 'month', { intervalCount: 3 })]))).toBeNull()
    expect(getSaveableMonthlyAmount(subscription({}, [item(0)]))).toBeNull()
  })
})

describe('offer by cancel reason', () => {
  it('offers credits worth one month to customers who barely use the plan', () => {
    expect(offerTypeFor('unused', 2900, 'usd')).toBe('credits')
    expect(offerTypeFor('other', 1400, 'eur')).toBe('credits')
    expect(creditsForMonthlyAmount(2900, 'usd')).toBe(29)
    expect(creditsForMonthlyAmount(1450, 'EUR')).toBe(15)
  })

  it('offers the discount for every other reason', () => {
    for (const reason of ['too_expensive', 'missing_features', 'switched_service', 'too_complex', 'low_quality', 'customer_service'] as const)
      expect(offerTypeFor(reason, 2900, 'usd')).toBe('discount')
  })

  it('falls back to the discount when the currency cannot become dollar credits', () => {
    expect(creditsForMonthlyAmount(700, 'brl')).toBeNull()
    expect(creditsForMonthlyAmount(1500, 'jpy')).toBeNull()
    expect(offerTypeFor('unused', 700, 'brl')).toBe('discount')
  })
})
