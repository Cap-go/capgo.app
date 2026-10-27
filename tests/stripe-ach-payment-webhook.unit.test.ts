import { describe, expect, it } from 'vitest'
import { stripeEventTestUtils } from '../supabase/functions/_backend/triggers/stripe_event.ts'
import { extractDataEvent } from '../supabase/functions/_backend/utils/stripe_event.ts'

const mockContext = {
  get: () => 'test-request-id',
} as any

const { decideInvoicePayment, isCancellationGraceEligible, resolveActiveSubscriptionStatus } = stripeEventTestUtils

function makeSubscriptionEvent(
  type: 'customer.subscription.created' | 'customer.subscription.updated' | 'customer.subscription.deleted',
  subscription: Record<string, unknown> = {},
) {
  return {
    created: 1_711_925_200,
    type,
    data: {
      object: {
        id: 'sub_ach',
        customer: 'cus_ach',
        status: 'active',
        items: {
          data: [{
            current_period_end: 1_714_517_200,
            current_period_start: 1_711_925_200,
            plan: { id: 'price_ach_monthly', interval: 'month', product: 'prod_ach', usage_type: 'licensed' },
          }],
        },
        ...subscription,
      },
    },
  } as any
}

function makeInvoiceEvent(type: 'invoice.paid' | 'invoice.payment_succeeded', invoice: Record<string, unknown> = {}) {
  return {
    created: 1_712_184_400,
    type,
    data: {
      object: {
        id: 'in_ach',
        object: 'invoice',
        customer: 'cus_ach',
        status: 'paid',
        parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_ach' } },
        ...invoice,
      },
    },
  } as any
}

describe('ACH subscription event extraction', () => {
  it.concurrent.each(['unpaid', 'incomplete_expired', 'canceled'])('maps a %s subscription to canceled', (status) => {
    const { data } = extractDataEvent(mockContext, makeSubscriptionEvent('customer.subscription.updated', { status }))
    expect(data.status).toBe('canceled')
  })

  it.concurrent('keeps an active subscription as a created or updated event, not as a payment', () => {
    expect(extractDataEvent(mockContext, makeSubscriptionEvent('customer.subscription.created')).data.status).toBe('created')
    expect(extractDataEvent(mockContext, makeSubscriptionEvent('customer.subscription.updated')).data.status).toBe('updated')
  })

  it.concurrent.each(['invoice.paid', 'invoice.payment_succeeded'] as const)('reads the customer and subscription of a paid %s', (type) => {
    const { data } = extractDataEvent(mockContext, makeInvoiceEvent(type))
    expect(data.customer_id).toBe('cus_ach')
    expect(data.subscription_id).toBe('sub_ach')
    expect(data.status).toBe('succeeded')
    // Plan fields stay owned by subscription events.
    expect(data.price_id).toBeUndefined()
    expect(data.product_id).toBeUndefined()
  })

  it.concurrent('does not treat an unpaid or one-off invoice as a subscription payment', () => {
    expect(extractDataEvent(mockContext, makeInvoiceEvent('invoice.paid', { status: 'open' })).data.status).toBe('updated')
    expect(extractDataEvent(mockContext, makeInvoiceEvent('invoice.paid', { parent: null })).data.subscription_id).toBeUndefined()
  })
})

describe('active subscription status gating', () => {
  const unpaid = { status: null, subscription_id: null }

  it.concurrent('does not grant paid status while the first payment is processing', () => {
    expect(resolveActiveSubscriptionStatus('created', unpaid, 'sub_ach', 'unpaid')).toBe('created')
    expect(resolveActiveSubscriptionStatus('updated', { status: 'created', subscription_id: 'sub_ach' }, 'sub_ach', 'unpaid')).toBe('updated')
  })

  it.concurrent('grants paid status once the payment is confirmed', () => {
    expect(resolveActiveSubscriptionStatus('created', unpaid, 'sub_ach', 'paid')).toBe('succeeded')
    expect(resolveActiveSubscriptionStatus('updated', { status: 'created', subscription_id: 'sub_ach' }, 'sub_ach', 'paid')).toBe('succeeded')
  })

  it.concurrent('keeps an already paid subscription paid, including legacy rows', () => {
    expect(resolveActiveSubscriptionStatus('updated', { status: 'succeeded', subscription_id: 'sub_ach' }, 'sub_ach', 'unpaid')).toBe('succeeded')
  })

  it.concurrent('requires a payment for a new subscription of a paying org', () => {
    expect(resolveActiveSubscriptionStatus('created', { status: 'succeeded', subscription_id: 'sub_old' }, 'sub_ach', 'unpaid')).toBe('created')
  })

  it.concurrent('keeps a failed payment visible until a payment succeeds', () => {
    expect(resolveActiveSubscriptionStatus('updated', { status: 'failed', subscription_id: 'sub_ach' }, 'sub_ach', 'unpaid')).toBe('failed')
    expect(resolveActiveSubscriptionStatus('updated', { status: 'failed', subscription_id: 'sub_ach' }, 'sub_ach', 'paid')).toBe('succeeded')
  })

  it.concurrent('keeps the past_due grace period for renewals only', () => {
    expect(resolveActiveSubscriptionStatus('past_due', { status: 'succeeded', subscription_id: 'sub_ach' }, 'sub_ach', 'unpaid')).toBe('past_due')
    expect(resolveActiveSubscriptionStatus('past_due', { status: 'failed', subscription_id: 'sub_ach' }, 'sub_ach', 'unpaid')).toBe('past_due')
    // A returned first ACH debit leaves the subscription past_due: no access.
    expect(resolveActiveSubscriptionStatus('past_due', { status: 'created', subscription_id: 'sub_ach' }, 'sub_ach', 'first_invoice_unpaid')).toBe('failed')
  })
})

describe('invoice payment confirmation under the row lock', () => {
  const eventAt = '2026-04-04T00:00:00.000Z'
  const before = '2026-04-03T00:00:00.000Z'
  const after = '2026-04-05T00:00:00.000Z'

  it.concurrent('marks the stored subscription paid', () => {
    expect(decideInvoicePayment({ status: 'created', subscription_id: 'sub_ach', last_stripe_event_at: before }, 'sub_ach', eventAt)).toBe('apply')
  })

  it.concurrent('applies a confirmation that a newer subscription event overtook', () => {
    expect(decideInvoicePayment({ status: 'updated', subscription_id: 'sub_ach', last_stripe_event_at: after }, 'sub_ach', eventAt)).toBe('apply')
  })

  it.concurrent('ignores invoices of another subscription', () => {
    expect(decideInvoicePayment({ status: 'created', subscription_id: 'sub_new', last_stripe_event_at: before }, 'sub_ach', eventAt)).toBe('skip')
    expect(decideInvoicePayment({ status: 'created', subscription_id: null, last_stripe_event_at: before }, 'sub_ach', eventAt)).toBe('skip')
  })

  it.concurrent('never restores a canceled subscription', () => {
    expect(decideInvoicePayment({ status: 'canceled', subscription_id: 'sub_ach', last_stripe_event_at: before }, 'sub_ach', eventAt)).toBe('skip')
    expect(decideInvoicePayment({ status: 'deleted', subscription_id: 'sub_ach', last_stripe_event_at: before }, 'sub_ach', eventAt)).toBe('skip')
  })

  it.concurrent('lets a newer failed payment win over an older confirmation', () => {
    expect(decideInvoicePayment({ status: 'failed', subscription_id: 'sub_ach', last_stripe_event_at: after }, 'sub_ach', eventAt)).toBe('skip')
    // A retry that succeeded after the failure restores access.
    expect(decideInvoicePayment({ status: 'failed', subscription_id: 'sub_ach', last_stripe_event_at: before }, 'sub_ach', eventAt)).toBe('apply')
  })

  it.concurrent('leaves paid rows alone, without backfilling legacy paid_at', () => {
    expect(decideInvoicePayment({ status: 'succeeded', subscription_id: 'sub_ach', last_stripe_event_at: before }, 'sub_ach', eventAt)).toBe('skip')
  })
})

describe('cancellation grace period', () => {
  const paid = { status: 'succeeded' as const }

  it.concurrent('keeps paid access to period end after a requested cancellation', () => {
    const event = makeSubscriptionEvent('customer.subscription.deleted', { status: 'canceled', cancellation_details: { reason: 'cancellation_requested' } })
    expect(isCancellationGraceEligible(event, paid)).toBe(true)
  })

  it.concurrent.each(['unpaid', 'incomplete_expired'])('gives no grace to a %s subscription', (status) => {
    expect(isCancellationGraceEligible(makeSubscriptionEvent('customer.subscription.updated', { status }), paid)).toBe(false)
  })

  it.concurrent('gives no grace when Stripe canceled after a failed payment', () => {
    const event = makeSubscriptionEvent('customer.subscription.deleted', { status: 'canceled', cancellation_details: { reason: 'payment_failed' } })
    expect(isCancellationGraceEligible(event, paid)).toBe(false)
  })

  it.concurrent.each(['created', 'updated', 'failed'] as const)('gives no grace to a %s org that never had a confirmed payment', (status) => {
    const event = makeSubscriptionEvent('customer.subscription.deleted', { status: 'canceled' })
    expect(isCancellationGraceEligible(event, { status })).toBe(false)
  })
})
