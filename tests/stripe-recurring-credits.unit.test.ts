import { describe, expect, it } from 'vitest'
import { getRecurringCreditInvoiceAmount } from '../supabase/functions/_backend/triggers/stripe_event.ts'
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
  const line = (product: string, amount: number, subscription = true) => ({
    amount,
    parent: subscription ? { subscription_item_details: { subscription: 'sub_1' } } : null,
    pricing: { price_details: { product, price: `price_${product}` } },
  })

  it.concurrent('grants the paid amount of subscription credit lines only', () => {
    const invoice = {
      lines: {
        data: [
          line('prod_enterprise', 23_900),
          line('prod_credits', 120_000),
          line('prod_credits', 5_000, false),
        ],
      },
    } as any
    expect(getRecurringCreditInvoiceAmount(invoice, creditProductIds)).toBe(1200)
  })

  it.concurrent('ignores negative proration lines after a downgrade', () => {
    const invoice = { lines: { data: [line('prod_credits', -40_000), line('prod_credits', 60_000)] } } as any
    expect(getRecurringCreditInvoiceAmount(invoice, creditProductIds)).toBe(600)
  })
})
