import { describe, expect, it } from 'vitest'
import { getRecurringCreditGrants } from '../supabase/functions/_backend/triggers/stripe_event.ts'
import { getRecurringCreditsPerMonth, isRecurringCreditPrice } from '../supabase/functions/_backend/utils/stripe.ts'
import { extractDataEvent } from '../supabase/functions/_backend/utils/stripe_event.ts'

const mockContext = {
  get: () => 'test-request-id',
} as any

function creditPrice(interval: 'month' | 'year') {
  return {
    id: `price_credits_${interval}`,
    lookup_key: `capgo_recurring_credits_${interval}_prod_credits`,
    metadata: { capgo_kind: 'recurring_credits' },
    recurring: { interval },
  }
}

function subscriptionItem(priceId: string, productId: string, interval: 'month' | 'year', price?: any, quantity = 1) {
  return {
    current_period_end: 1_714_517_200,
    current_period_start: 1_711_925_200,
    quantity,
    price,
    plan: { id: priceId, interval, product: productId, usage_type: 'licensed' },
  } as any
}

describe('recurring credit subscription items', () => {
  it.concurrent('detects tagged credit prices by metadata or lookup key', () => {
    expect(isRecurringCreditPrice({ metadata: { capgo_kind: 'recurring_credits' } })).toBe(true)
    expect(isRecurringCreditPrice({ lookup_key: 'capgo_recurring_credits_month_prod_x' })).toBe(true)
    expect(isRecurringCreditPrice({ lookup_key: 'enterprise_month', metadata: {} })).toBe(false)
    expect(isRecurringCreditPrice(undefined)).toBe(false)
  })

  it.concurrent('reports the monthly equivalent of credit items', () => {
    expect(getRecurringCreditsPerMonth([
      { price: creditPrice('month'), quantity: 1200 },
      { price: { lookup_key: null, metadata: {} }, quantity: 1 },
    ] as any)).toBe(1200)
    expect(getRecurringCreditsPerMonth([{ price: creditPrice('year'), quantity: 14_400 }] as any)).toBe(1200)
  })

  it.concurrent('keeps the plan item as the subscription plan when a credit item comes first', () => {
    const { data } = extractDataEvent(mockContext, {
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_enterprise_3m',
          customer: 'cus_enterprise_3m',
          status: 'active',
          items: {
            data: [
              subscriptionItem('price_credits_month', 'prod_credits', 'month', creditPrice('month'), 1200),
              subscriptionItem('price_enterprise_month', 'prod_enterprise', 'month', { lookup_key: null, metadata: {}, recurring: { interval: 'month' } }),
            ],
          },
        },
        previous_attributes: {},
      },
    } as any)

    expect(data.price_id).toBe('price_enterprise_month')
    expect(data.product_id).toBe('prod_enterprise')
    expect(data.recurring_credits).toBe(1200)
  })
})

describe('recurring credit invoices', () => {
  const creditProductIds = new Set(['prod_credits'])
  const OCT_1 = Date.UTC(2026, 9, 1) / 1000
  const NOV_1 = Date.UTC(2026, 10, 1) / 1000
  const NEXT_OCT_1 = Date.UTC(2027, 9, 1) / 1000
  const line = (id: string, product: string, amount: number, start = OCT_1, end = NOV_1, subscription = true) => ({
    id,
    amount,
    period: { start, end },
    parent: subscription ? { subscription_item_details: { subscription: 'sub_1' } } : null,
    pricing: { price_details: { product, price: `price_${product}` } },
  })

  it.concurrent('grants monthly credit lines once, expiring at the end of the month', () => {
    const invoice = {
      id: 'in_1',
      lines: {
        data: [
          line('il_plan', 'prod_enterprise', 23_900),
          line('il_credits', 'prod_credits', 120_000),
          line('il_one_off', 'prod_credits', 5_000, OCT_1, NOV_1, false),
        ],
      },
    } as any
    expect(getRecurringCreditGrants(invoice, creditProductIds)).toEqual([
      { amount: 1200, expiresAt: '2026-11-01T00:00:00.000Z', key: 'in_1:il_credits:0' },
    ])
  })

  it.concurrent('splits a yearly credit line into 12 grants that expire month by month', () => {
    const invoice = { id: 'in_y', lines: { data: [line('il_y', 'prod_credits', 1_440_000, OCT_1, NEXT_OCT_1)] } } as any
    const grants = getRecurringCreditGrants(invoice, creditProductIds)
    expect(grants).toHaveLength(12)
    expect(grants.every(grant => grant.amount === 1200)).toBe(true)
    expect(grants[0].expiresAt).toBe('2026-11-01T00:00:00.000Z')
    expect(grants[11].expiresAt).toBe('2027-10-01T00:00:00.000Z')
    expect(new Set(grants.map(grant => grant.key)).size).toBe(12)
  })

  it.concurrent('ignores negative proration lines and keeps uneven splits exact', () => {
    const invoice = {
      id: 'in_p',
      lines: { data: [line('il_neg', 'prod_credits', -40_000), line('il_pos', 'prod_credits', 100_000, OCT_1, Date.UTC(2027, 0, 1) / 1000)] },
    } as any
    const grants = getRecurringCreditGrants(invoice, creditProductIds)
    expect(grants.map(grant => grant.amount)).toEqual([333.33, 333.33, 333.34])
    expect(grants.reduce((total, grant) => total + grant.amount, 0)).toBeCloseTo(1000)
  })
})
