import { describe, expect, it } from 'vitest'
import { stripeEventTestUtils } from '../supabase/functions/_backend/triggers/stripe_event.ts'
import { orgEmailNotificationTestUtils } from '../supabase/functions/_backend/utils/org_email_notifications.ts'
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

describe('dunning Bento events', () => {
  it.concurrent('uses Capgo events so Bento can start and stop dunning for every org member', () => {
    expect(stripeEventTestUtils.BENTO_FAILED_PAYMENT_EVENT).toBe('org:failed_payment')
    expect(stripeEventTestUtils.BENTO_CHARGE_SUCCEEDED_EVENT).toBe('org:charge_succeeded')
    expect(stripeEventTestUtils.BENTO_DUNNING_EVENT_AUDIENCE).toBe('all')
    expect(stripeEventTestUtils.BENTO_TAG_AUDIENCE).toBe('billing')
    expect(orgEmailNotificationTestUtils.AUDIENCE_ROLE_NAMES.all).toEqual([])
    expect(orgEmailNotificationTestUtils.AUDIENCE_ROLE_NAMES.billing).toEqual([
      'org_super_admin',
      'org_billing_admin',
    ])
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
