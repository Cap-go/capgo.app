import { describe, expect, it } from 'vitest'
import { stripeEventTestUtils } from '../supabase/functions/_backend/triggers/stripe_event.ts'
import { extractDataEvent } from '../supabase/functions/_backend/utils/stripe_event.ts'

const mockContext = {
  get: () => 'test-request-id',
} as any

describe('stripe billing Bento tag updates', () => {
  it.concurrent('normalizes and deduplicates every billing-linked email', () => {
    const segment = {
      segments: ['capgo', 'paying', 'plan:Solo'],
      deleteSegments: ['trial', 'trial0', 'canceled'],
    }

    expect(stripeEventTestUtils.buildBillingBentoTagUpdates([
      'Owner@Example.com ',
      'owner@example.com',
      'billing@stripe.example',
      null,
      '',
      ' Billing@Stripe.Example ',
      'creator@example.com',
    ], segment)).toEqual([
      { email: 'owner@example.com', segments: segment.segments, deleteSegments: segment.deleteSegments },
      { email: 'billing@stripe.example', segments: segment.segments, deleteSegments: segment.deleteSegments },
      { email: 'creator@example.com', segments: segment.segments, deleteSegments: segment.deleteSegments },
    ])
  })

  it.concurrent('keeps unique billing emails in first-seen order', () => {
    expect(stripeEventTestUtils.uniqueBillingEmails([
      ' Owner@Example.com ',
      'owner@example.com',
      'billing@stripe.example',
      null,
      ' Billing@Stripe.Example ',
      'creator@example.com',
    ])).toEqual([
      'owner@example.com',
      'billing@stripe.example',
      'creator@example.com',
    ])
  })
})

describe('dunning Bento stop event', () => {
  it.concurrent('uses a Capgo event so Bento can exit dunning for billing contacts', () => {
    expect(stripeEventTestUtils.BENTO_CHARGE_SUCCEEDED_EVENT).toBe('org:charge_succeeded')
  })
})

describe('stripe charge events', () => {
  it.concurrent('extracts the customer id from charge.succeeded', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          customer: 'cus_charge_ok',
          id: 'ch_ok',
          object: 'charge',
        },
      },
      type: 'charge.succeeded',
    } as any)

    expect(stripeData.data.customer_id).toBe('cus_charge_ok')
    expect(stripeData.data.status).toBe('succeeded')
  })

  it.concurrent('extracts the customer id from charge.failed', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          customer: 'cus_charge_fail',
          id: 'ch_fail',
          object: 'charge',
        },
      },
      type: 'charge.failed',
    } as any)

    expect(stripeData.data.customer_id).toBe('cus_charge_fail')
    expect(stripeData.data.status).toBe('failed')
  })

  it.concurrent('leaves customer_id empty when charge.succeeded has no customer', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          customer: null,
          id: 'ch_no_customer',
          object: 'charge',
        },
      },
      type: 'charge.succeeded',
    } as any)

    expect(stripeData.data.customer_id).toBe('')
  })

  it.concurrent('leaves customer_id empty when charge.failed has no customer', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          customer: null,
          id: 'ch_fail_no_customer',
          object: 'charge',
        },
      },
      type: 'charge.failed',
    } as any)

    expect(stripeData.data.customer_id).toBe('')
  })

  it.concurrent('extracts the customer id from an expanded charge customer', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          customer: {
            id: 'cus_expanded',
            object: 'customer',
          },
          id: 'ch_expanded',
          object: 'charge',
        },
      },
      type: 'charge.succeeded',
    } as any)

    expect(stripeData.data.customer_id).toBe('cus_expanded')
  })
})
