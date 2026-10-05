import { describe, expect, it } from 'vitest'
import { buildExtraMauTiers, getExtraMau, isExtraMauPrice } from '../supabase/functions/_backend/utils/stripe.ts'
import { extractDataEvent } from '../supabase/functions/_backend/utils/stripe_event.ts'

const mockContext = {
  get: () => 'test-request-id',
} as any

const OPEN = 9223372036854775807
const mauSteps = [
  { step_min: 0, step_max: 1_000_000, price_per_unit: 0.003 },
  { step_min: 1_000_000, step_max: 3_000_000, price_per_unit: 0.0006 },
  { step_min: 3_000_000, step_max: 6_000_000, price_per_unit: 0.00045 },
  { step_min: 6_000_000, step_max: OPEN, price_per_unit: 0.00035 },
]

const extraMauPrice = {
  id: 'price_extra_mau_month',
  lookup_key: 'capgo_extra_mau_month_abc',
  metadata: { capgo_kind: 'extra_mau' },
  recurring: { interval: 'month' },
}

function subscriptionItem(priceId: string, productId: string, price: any, quantity = 1) {
  return {
    current_period_end: 1_714_517_200,
    current_period_start: 1_711_925_200,
    quantity,
    price,
    plan: { id: priceId, interval: 'month', product: productId, usage_type: 'licensed' },
  } as any
}

describe('enterprise extra MAU item', () => {
  it.concurrent('detects tagged extra MAU prices by metadata or lookup key', () => {
    expect(isExtraMauPrice({ metadata: { capgo_kind: 'extra_mau' } })).toBe(true)
    expect(isExtraMauPrice({ lookup_key: 'capgo_extra_mau_year_x' })).toBe(true)
    expect(isExtraMauPrice({ lookup_key: 'enterprise_month', metadata: {} })).toBe(false)
    expect(isExtraMauPrice(undefined)).toBe(false)
  })

  it.concurrent('counts extra MAU in units of 1,000', () => {
    expect(getExtraMau([
      { price: extraMauPrice, quantity: 2000 },
      { price: { lookup_key: null, metadata: {} }, quantity: 1 },
    ] as any)).toBe(2_000_000)
  })

  it.concurrent('builds graduated per-1k tiers above the plan allowance', () => {
    expect(buildExtraMauTiers(mauSteps, 1_000_000, 'month')).toEqual([
      { up_to: 2000, unit_amount: 60 },
      { up_to: 5000, unit_amount: 45 },
      { up_to: 'inf', unit_amount: 35 },
    ])
    expect(buildExtraMauTiers(mauSteps, 1_000_000, 'year')[0]).toEqual({ up_to: 2000, unit_amount: 720 })
  })

  it.concurrent('keeps the plan item as the plan and syncs extra MAU when the extra item comes first', () => {
    const { data } = extractDataEvent(mockContext, {
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_enterprise_3m',
          customer: 'cus_enterprise_3m',
          status: 'active',
          items: {
            data: [
              subscriptionItem('price_extra_mau_month', 'prod_extra_mau', extraMauPrice, 2000),
              subscriptionItem('price_enterprise_month', 'prod_enterprise', { lookup_key: null, metadata: {}, recurring: { interval: 'month' } }),
            ],
          },
        },
        previous_attributes: {},
      },
    } as any)

    expect(data.price_id).toBe('price_enterprise_month')
    expect(data.product_id).toBe('prod_enterprise')
    expect(data.extra_mau).toBe(2_000_000)
  })
})
