import { describe, expect, it } from 'vitest'
import { stripeEventTestUtils } from '../supabase/functions/_backend/triggers/stripe_event.ts'
import {
  extractDataEvent,
  isCheckoutSessionPaid,
  isInvoicePaid,
} from '../supabase/functions/_backend/utils/stripe_event.ts'

const mockContext = {
  get: () => 'test-request-id',
} as any

function makeSubscriptionItem(priceId: string, productId: string) {
  return {
    current_period_end: 1_780_000_000,
    current_period_start: 1_777_000_000,
    plan: {
      id: priceId,
      interval: 'month',
      product: productId,
      usage_type: 'licensed',
    },
  } as any
}

describe('stripe ACH and async payment webhook gating', () => {
  it.concurrent('does not mark checkout.session.completed as paid while payment is processing', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          customer: 'cus_ach_checkout',
          id: 'cs_ach_checkout',
          mode: 'subscription',
          object: 'checkout.session',
          payment_status: 'unpaid',
          status: 'complete',
        },
      },
      type: 'checkout.session.completed',
    } as any)

    expect(isCheckoutSessionPaid(stripeData.data as any)).toBe(false)
    expect(stripeData.data.status).toBe('updated')
  })

  it.concurrent('marks checkout.session.async_payment_succeeded as paid', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          customer: 'cus_ach_checkout',
          id: 'cs_ach_checkout',
          mode: 'subscription',
          object: 'checkout.session',
          payment_status: 'paid',
          status: 'complete',
        },
      },
      type: 'checkout.session.async_payment_succeeded',
    } as any)

    expect(stripeData.data.status).toBe('succeeded')
  })

  it.concurrent('maps payment_intent.processing without a succeeded status', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          customer: 'cus_ach_pi',
          id: 'pi_processing',
          object: 'payment_intent',
          status: 'processing',
          payment_method_types: ['us_bank_account'],
        },
      },
      type: 'payment_intent.processing',
    } as any)

    expect(stripeData.data.status).toBe('updated')
    expect(
      stripeEventTestUtils.getPaidAtUpdate(
        { paid_at: null, status: null },
        stripeData.data.status,
        '2026-09-01T12:00:00.000Z',
      ),
    ).toBeUndefined()
  })

  it.concurrent('marks paid only after payment_intent.succeeded', () => {
    const eventOccurredAtIso = '2026-09-02T12:00:00.000Z'
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          customer: 'cus_ach_pi',
          id: 'pi_succeeded',
          object: 'payment_intent',
          status: 'succeeded',
          payment_method_types: ['us_bank_account'],
        },
      },
      type: 'payment_intent.succeeded',
    } as any)

    expect(stripeData.data.status).toBe('succeeded')
    expect(
      stripeEventTestUtils.getPaidAtUpdate(
        { paid_at: null, status: 'created' },
        stripeData.data.status,
        eventOccurredAtIso,
      ),
    ).toBe(eventOccurredAtIso)
  })

  it.concurrent('maps payment_intent.payment_failed to failed without paid_at', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          customer: 'cus_ach_pi',
          id: 'pi_failed',
          object: 'payment_intent',
          status: 'requires_payment_method',
          payment_method_types: ['us_bank_account'],
        },
      },
      type: 'payment_intent.payment_failed',
    } as any)

    expect(stripeData.data.status).toBe('failed')
    expect(
      stripeEventTestUtils.getPaidAtUpdate(
        { paid_at: null, status: 'created' },
        stripeData.data.status,
        '2026-09-03T12:00:00.000Z',
      ),
    ).toBeUndefined()
  })

  it.concurrent('marks invoice.paid as succeeded only when invoice status is paid', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          customer: 'cus_ach_invoice',
          id: 'in_paid',
          object: 'invoice',
          status: 'paid',
          lines: {
            data: [
              {
                parent: {
                  subscription_item_details: {
                    subscription: 'sub_ach_invoice',
                  },
                },
                pricing: {
                  price_details: {
                    price: 'price_team_monthly',
                    product: 'prod_team',
                  },
                },
              },
            ],
          },
        },
      },
      type: 'invoice.paid',
    } as any)

    expect(isInvoicePaid({ status: 'paid' })).toBe(true)
    expect(stripeData.data.status).toBe('succeeded')
    expect(stripeData.data.subscription_id).toBe('sub_ach_invoice')
    expect(stripeData.data.price_id).toBe('price_team_monthly')
    expect(stripeData.data.product_id).toBe('prod_team')
  })

  it.concurrent('maps invoice.payment_failed to failed', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          customer: 'cus_ach_invoice',
          id: 'in_failed',
          object: 'invoice',
          status: 'open',
          lines: {
            data: [
              {
                parent: {
                  subscription_item_details: {
                    subscription: 'sub_ach_invoice',
                  },
                },
                pricing: {
                  price_details: {
                    price: 'price_team_monthly',
                    product: 'prod_team',
                  },
                },
              },
            ],
          },
        },
      },
      type: 'invoice.payment_failed',
    } as any)

    expect(stripeData.data.status).toBe('failed')
  })

  it.concurrent('maps customer.subscription.deleted to canceled with canceled_at', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          customer: 'cus_deleted',
          id: 'sub_deleted',
          object: 'subscription',
          status: 'canceled',
          ended_at: 1_780_000_000,
          items: {
            data: [
              makeSubscriptionItem('price_team_monthly', 'prod_team'),
            ],
          },
        },
      },
      type: 'customer.subscription.deleted',
    } as any)

    expect(stripeData.data.status).toBe('canceled')
    expect(stripeData.data.canceled_at).toBe('2026-05-28T20:26:40.000Z')
  })

  it.concurrent('keeps paying customers on succeeded during subscription renewals', () => {
    expect(stripeEventTestUtils.resolveSubscriptionPersistedStatus(
      'updated',
      { status: 'succeeded', paid_at: '2026-01-01T00:00:00.000Z' },
    )).toBe('succeeded')
    expect(stripeEventTestUtils.resolveSubscriptionPersistedStatus(
      'created',
      { paid_at: null, status: null },
    )).toBe('created')
  })
})
