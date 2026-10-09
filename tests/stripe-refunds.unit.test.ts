import { describe, expect, it } from 'vitest'
import { globalStatsTestUtils } from '../supabase/functions/_backend/triggers/global_stats.ts'
import { extractDataEvent } from '../supabase/functions/_backend/utils/stripe_event.ts'
import { toStripeRefundRow } from '../supabase/functions/_backend/utils/stripe_refunds.ts'

const mockContext = {
  get: () => 'test-request-id',
} as any

describe('stripe refunds', () => {
  it.concurrent('extracts the customer from charge.refunded events', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          customer: 'cus_refund_test',
          id: 'ch_refund_test',
        },
      },
      type: 'charge.refunded',
    } as any)

    expect(stripeData.data.customer_id).toBe('cus_refund_test')
  })

  it.concurrent('maps a Stripe refund to one stripe_refunds row', () => {
    const row = toStripeRefundRow({
      amount: 1200,
      created: 1_791_292_895,
      currency: 'usd',
      id: 're_refund_test',
      reason: 'requested_by_customer',
      status: 'succeeded',
    } as any, { customer: { id: 'cus_refund_test' } as any, id: 'ch_refund_test' })

    expect(row).toMatchObject({
      amount: 1200,
      charge_id: 'ch_refund_test',
      currency: 'usd',
      customer_id: 'cus_refund_test',
      id: 're_refund_test',
      reason: 'requested_by_customer',
      refunded_at: new Date(1_791_292_895 * 1000).toISOString(),
      status: 'succeeded',
    })
  })

  it.concurrent('keeps refunds on charges without a customer', () => {
    const row = toStripeRefundRow({
      amount: 500,
      created: 1_791_292_895,
      currency: 'usd',
      id: 're_guest_refund',
      reason: null,
      status: null,
    } as any, { customer: null, id: 'ch_guest_refund' })

    expect(row.customer_id).toBeNull()
    expect(row.status).toBe('pending')
  })

  it.concurrent('sums daily refunds in USD and skips failed or canceled ones', () => {
    expect(globalStatsTestUtils.summarizeRefunds([
      { amount: 1200, currency: 'usd', status: 'succeeded' },
      { amount: 1999, currency: 'USD', status: 'pending' },
      { amount: 5000, currency: 'eur', status: 'succeeded' },
      { amount: 700, currency: 'usd', status: 'failed' },
      { amount: 300, currency: 'usd', status: 'canceled' },
    ])).toEqual({ refunds_count: 3, refunds_amount: 31.99 })

    expect(globalStatsTestUtils.summarizeRefunds([])).toEqual({ refunds_count: 0, refunds_amount: 0 })
  })
})
