import { describe, expect, it } from 'vitest'
import { extractDataEvent } from '../supabase/functions/_backend/utils/stripe_event.ts'

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
})
