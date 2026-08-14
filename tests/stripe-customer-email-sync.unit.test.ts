import { describe, expect, it } from 'vitest'
import { stripeEventTestUtils } from '../supabase/functions/_backend/triggers/stripe_event.ts'
import { extractDataEvent, getStripeCustomerEmailFromEvent } from '../supabase/functions/_backend/utils/stripe_event.ts'

const mockContext = {
  get: () => 'test-request-id',
} as any

function makeCustomerEvent(type: 'customer.created' | 'customer.updated', customer: Record<string, unknown>) {
  return {
    created: 1_711_925_200,
    data: {
      object: {
        id: 'cus_billing_email',
        object: 'customer',
        ...customer,
      },
    },
    type,
  } as any
}

describe('stripe customer billing email sync', () => {
  it.concurrent('extracts a normalized customer email from customer.updated', () => {
    const event = makeCustomerEvent('customer.updated', {
      email: ' Billing@Stripe.Example ',
    })

    expect(getStripeCustomerEmailFromEvent(event)).toBe('billing@stripe.example')
    expect(extractDataEvent(mockContext, event).data.customer_id).toBe('cus_billing_email')
  })

  it.concurrent('extracts a normalized customer email from customer.created', () => {
    expect(getStripeCustomerEmailFromEvent(makeCustomerEvent('customer.created', {
      email: 'INVOICES@org.example',
    }))).toBe('invoices@org.example')
  })

  it.concurrent('ignores missing, blank, or deleted Stripe customer emails', () => {
    expect(getStripeCustomerEmailFromEvent(makeCustomerEvent('customer.updated', {
      email: null,
    }))).toBeNull()
    expect(getStripeCustomerEmailFromEvent(makeCustomerEvent('customer.updated', {
      email: '   ',
    }))).toBeNull()
    expect(getStripeCustomerEmailFromEvent({
      data: {
        object: {
          deleted: true,
          id: 'cus_deleted',
          object: 'customer',
        },
      },
      type: 'customer.updated',
    } as any)).toBeNull()
  })

  it.concurrent('does not read an email from non-customer profile events', () => {
    expect(getStripeCustomerEmailFromEvent({
      data: {
        object: {
          customer: 'cus_billing_email',
          email: 'ignored@example.com',
          id: 'sub_123',
          object: 'subscription',
        },
      },
      type: 'customer.subscription.updated',
    } as any)).toBeNull()
  })

  it.concurrent('replaces the org management email only when Stripe has a different address', () => {
    expect(stripeEventTestUtils.shouldReplaceOrgManagementEmail(
      'old@example.com',
      'invoices@example.com',
    )).toBe(true)
    expect(stripeEventTestUtils.shouldReplaceOrgManagementEmail(
      'Invoices@Example.com ',
      'invoices@example.com',
    )).toBe(false)
    expect(stripeEventTestUtils.shouldReplaceOrgManagementEmail(
      'old@example.com',
      null,
    )).toBe(false)
    expect(stripeEventTestUtils.shouldReplaceOrgManagementEmail(
      null,
      'invoices@example.com',
    )).toBe(true)
  })

  it.concurrent('only treats customer.updated as an email change when previous_attributes includes email', () => {
    expect(stripeEventTestUtils.didStripeCustomerEmailChange(makeCustomerEvent('customer.updated', {
      email: 'invoices@example.com',
    }))).toBe(false)

    expect(stripeEventTestUtils.didStripeCustomerEmailChange({
      ...makeCustomerEvent('customer.updated', { email: 'invoices@example.com' }),
      data: {
        object: {
          email: 'invoices@example.com',
          id: 'cus_billing_email',
          object: 'customer',
        },
        previous_attributes: {
          email: 'old@example.com',
        },
      },
    })).toBe(true)

    expect(stripeEventTestUtils.didStripeCustomerEmailChange({
      ...makeCustomerEvent('customer.updated', { email: 'invoices@example.com' }),
      data: {
        object: {
          email: 'invoices@example.com',
          id: 'cus_billing_email',
          object: 'customer',
        },
        previous_attributes: {
          name: 'New name',
        },
      },
    })).toBe(false)
  })

  it.concurrent('treats customer.created as an email change so a mismatched first email can be repaired', () => {
    expect(stripeEventTestUtils.didStripeCustomerEmailChange(makeCustomerEvent('customer.created', {
      email: 'invoices@example.com',
    }))).toBe(true)
  })
})
