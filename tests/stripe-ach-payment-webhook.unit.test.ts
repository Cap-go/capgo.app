import { describe, expect, it } from 'vitest'
import { stripeEventTestUtils } from '../supabase/functions/_backend/triggers/stripe_event.ts'
import { extractDataEvent } from '../supabase/functions/_backend/utils/stripe_event.ts'

const mockContext = {
  get: () => 'test-request-id',
} as any

const FIXTURE_CUSTOMER = 'cus_ach_sequence_fixture'
const FIXTURE_SUBSCRIPTION = 'sub_ach_sequence_fixture'
const FIXTURE_PRICE = 'price_team_monthly_fixture'
const FIXTURE_PRODUCT = 'prod_team_fixture'

function stripeEvent(type: string, object: Record<string, unknown>) {
  return { type, data: { object } } as any
}

function extract(type: string, object: Record<string, unknown>) {
  return extractDataEvent(mockContext, stripeEvent(type, object)).data
}

function makeSubscriptionItem() {
  return {
    current_period_end: 1_780_000_000,
    current_period_start: 1_777_000_000,
    plan: {
      id: FIXTURE_PRICE,
      interval: 'month',
      product: FIXTURE_PRODUCT,
      usage_type: 'licensed',
    },
  }
}

function makeOpenSubscriptionCreateInvoice() {
  return {
    customer: FIXTURE_CUSTOMER,
    id: 'in_open_subscription_create',
    object: 'invoice',
    status: 'open',
    billing_reason: 'subscription_create',
    attempt_count: 0,
    lines: {
      data: [
        {
          parent: {
            subscription_item_details: {
              subscription: FIXTURE_SUBSCRIPTION,
            },
          },
          pricing: {
            price_details: {
              price: FIXTURE_PRICE,
              product: FIXTURE_PRODUCT,
            },
          },
        },
      ],
    },
  }
}

import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'

type StripeStatus = Database['public']['Enums']['stripe_status'] | null

type StripeInfoState = {
  status: StripeStatus
  paid_at: string | null
  canceled_at: string | null
  subscription_id?: string | null
}

function withStoredSubscriptionId(
  state: StripeInfoState,
  extracted: ReturnType<typeof extract>,
  previous: StripeInfoState,
): StripeInfoState {
  const subscriptionId = extracted.subscription_id ?? previous.subscription_id
  if (subscriptionId)
    return { ...state, subscription_id: subscriptionId }
  return state
}

function applyWebhookToStripeInfoState(
  current: StripeInfoState,
  type: string,
  object: Record<string, unknown>,
  eventOccurredAtIso: string,
): StripeInfoState {
  if (type === 'payment_intent.payment_failed' || type === 'payment_intent.succeeded')
    return current

  const extracted = extract(type, object)

  if ((type === 'invoice.paid' || type === 'invoice.payment_succeeded' || type === 'invoice.payment_failed')
    && !stripeEventTestUtils.shouldApplyInvoiceToStoredSubscription(current.subscription_id, extracted.subscription_id)) {
    return current
  }

  const merged = stripeEventTestUtils.mergeStripeWebhookExtractIntoStripeInfoState(
    current,
    extracted,
    eventOccurredAtIso,
  )
  return withStoredSubscriptionId(merged, extracted, current)
}

describe('stripe ACH sequence fixtures (a) processing must not mark paid', () => {
  it.concurrent('checkout unpaid, subscription active, open invoice, and PI processing stay not paid', () => {
    let state: StripeInfoState = { status: null, paid_at: null, canceled_at: null }
    const ts = '2026-09-01T10:00:00.000Z'

    state = applyWebhookToStripeInfoState(state, 'checkout.session.completed', {
      customer: FIXTURE_CUSTOMER,
      id: 'cs_ach_fixture',
      object: 'checkout.session',
      mode: 'subscription',
      payment_status: 'unpaid',
      status: 'complete',
    }, ts)

    expect(extract('checkout.session.completed', {
      customer: FIXTURE_CUSTOMER,
      object: 'checkout.session',
      payment_status: 'unpaid',
      status: 'complete',
    }).status).toBe('updated')
    expect(stripeEventTestUtils.hasStripePaidAccess(state)).toBe(false)

    state = applyWebhookToStripeInfoState(state, 'customer.subscription.created', {
      customer: FIXTURE_CUSTOMER,
      id: FIXTURE_SUBSCRIPTION,
      object: 'subscription',
      status: 'active',
      items: { data: [makeSubscriptionItem()] },
    }, ts)

    expect(state.subscription_id).toBe(FIXTURE_SUBSCRIPTION)
    expect(state.status).toBe('created')
    expect(stripeEventTestUtils.hasStripePaidAccess(state)).toBe(false)

    state = applyWebhookToStripeInfoState(state, 'invoice.finalized', makeOpenSubscriptionCreateInvoice(), ts)
    state = applyWebhookToStripeInfoState(state, 'payment_intent.processing', {
      customer: FIXTURE_CUSTOMER,
      id: 'pi_ach_processing',
      object: 'payment_intent',
      status: 'processing',
      payment_method_types: ['us_bank_account'],
    }, ts)
    state = applyWebhookToStripeInfoState(state, 'charge.pending', {
      customer: FIXTURE_CUSTOMER,
      id: 'ch_pending',
      object: 'charge',
      status: 'pending',
    }, ts)

    expect(stripeEventTestUtils.hasStripePaidAccess(state)).toBe(false)
    expect(state.paid_at).toBeNull()
  })
})

describe('stripe ACH sequence fixtures (b) failure reverts paid access', () => {
  it.concurrent('invoice.payment_failed marks failed while payment_intent.payment_failed is ignored', () => {
    let state: StripeInfoState = {
      status: 'succeeded',
      paid_at: '2026-09-01T10:00:00.000Z',
      canceled_at: null,
      subscription_id: FIXTURE_SUBSCRIPTION,
    }
    const ts = '2026-09-02T12:00:00.000Z'

    state = applyWebhookToStripeInfoState(state, 'payment_intent.payment_failed', {
      customer: FIXTURE_CUSTOMER,
      id: 'pi_ach_failed',
      object: 'payment_intent',
      status: 'requires_payment_method',
      payment_method_types: ['us_bank_account'],
      last_payment_error: { code: 'insufficient_funds', decline_code: 'insufficient_funds' },
    }, ts)

    expect(state.status).toBe('succeeded')
    expect(stripeEventTestUtils.hasStripePaidAccess(state)).toBe(true)

    state = applyWebhookToStripeInfoState(state, 'invoice.payment_failed', {
      ...makeOpenSubscriptionCreateInvoice(),
      attempt_count: 1,
    }, ts)

    expect(state.status).toBe('failed')
    expect(stripeEventTestUtils.hasStripePaidAccess(state)).toBe(false)
  })
})

describe('stripe ACH sequence fixtures (c) terminal cancellation', () => {
  it.concurrent('subscription deleted sets canceled and canceled_at', () => {
    const endedAt = 1_780_000_000
    const extracted = extract('customer.subscription.deleted', {
      customer: FIXTURE_CUSTOMER,
      id: FIXTURE_SUBSCRIPTION,
      object: 'subscription',
      status: 'canceled',
      ended_at: endedAt,
      cancellation_details: { reason: 'payment_failed' },
      items: { data: [makeSubscriptionItem()] },
    })

    expect(extracted.status).toBe('canceled')
    expect(extracted.canceled_at).toBe(new Date(endedAt * 1000).toISOString())

    const state = stripeEventTestUtils.mergeStripeWebhookExtractIntoStripeInfoState(
      { status: 'succeeded', paid_at: '2026-09-01T10:00:00.000Z', canceled_at: null },
      extracted,
      '2026-09-03T12:00:00.000Z',
    )

    expect(state.status).toBe('canceled')
    expect(state.canceled_at).toBe(extracted.canceled_at)
    expect(stripeEventTestUtils.hasStripePaidAccess(state)).toBe(false)
  })

  it.concurrent('invoice.marked_uncollectible maps to canceled', () => {
    const extracted = extract('invoice.marked_uncollectible', makeOpenSubscriptionCreateInvoice())
    expect(extracted.status).toBe('canceled')

    const state = stripeEventTestUtils.mergeStripeWebhookExtractIntoStripeInfoState(
      { status: 'succeeded', paid_at: '2026-09-01T10:00:00.000Z', canceled_at: null },
      extracted,
      '2026-09-03T12:00:00.000Z',
    )

    expect(state.status).toBe('canceled')
    expect(stripeEventTestUtils.hasStripePaidAccess(state)).toBe(false)
  })
})

describe('stripe ACH sequence fixtures (d) payment method setup must not mark paid', () => {
  it.concurrent('setup_intent.succeeded and payment_method.attached leave paid state unchanged', () => {
    const current: StripeInfoState = {
      status: 'canceled',
      paid_at: null,
      canceled_at: '2026-09-03T12:00:00.000Z',
    }
    const ts = '2026-09-04T08:00:00.000Z'

    expect(extract('setup_intent.succeeded', {
      customer: FIXTURE_CUSTOMER,
      id: 'seti_fixture',
      object: 'setup_intent',
      status: 'succeeded',
      payment_method_types: ['us_bank_account'],
    }).status).toBe('updated')

    expect(extract('payment_method.attached', {
      customer: FIXTURE_CUSTOMER,
      id: 'pm_fixture',
      object: 'payment_method',
      type: 'us_bank_account',
    }).status).toBe('updated')

    const afterSetup = applyWebhookToStripeInfoState(current, 'setup_intent.succeeded', {
      customer: FIXTURE_CUSTOMER,
      id: 'seti_fixture',
      object: 'setup_intent',
      status: 'succeeded',
    }, ts)

    const afterAttach = applyWebhookToStripeInfoState(afterSetup, 'payment_method.attached', {
      customer: FIXTURE_CUSTOMER,
      id: 'pm_fixture',
      object: 'payment_method',
      type: 'us_bank_account',
    }, ts)

    expect(afterAttach.status).toBe('canceled')
    expect(afterAttach.paid_at).toBeNull()
    expect(stripeEventTestUtils.hasStripePaidAccess(afterAttach)).toBe(false)
  })
})

describe('stripe ACH sequence happy path', () => {
  it.concurrent('processing then invoice.paid marks paid once', () => {
    let state: StripeInfoState = {
      status: 'created',
      paid_at: null,
      canceled_at: null,
      subscription_id: FIXTURE_SUBSCRIPTION,
    }
    const processingAt = '2026-09-01T10:00:00.000Z'
    const paidAt = '2026-09-03T15:00:00.000Z'

    state = applyWebhookToStripeInfoState(state, 'payment_intent.processing', {
      customer: FIXTURE_CUSTOMER,
      id: 'pi_ach_processing',
      object: 'payment_intent',
      status: 'processing',
      payment_method_types: ['us_bank_account'],
    }, processingAt)

    expect(stripeEventTestUtils.hasStripePaidAccess(state)).toBe(false)

    state = applyWebhookToStripeInfoState(state, 'invoice.paid', {
      ...makeOpenSubscriptionCreateInvoice(),
      status: 'paid',
    }, paidAt)

    expect(state.status).toBe('succeeded')
    expect(state.paid_at).toBe(paidAt)
    expect(stripeEventTestUtils.hasStripePaidAccess(state)).toBe(true)
  })

  it.concurrent('payment_intent.succeeded does not mark paid without invoice.paid', () => {
    let state: StripeInfoState = {
      status: 'created',
      paid_at: null,
      canceled_at: null,
      subscription_id: FIXTURE_SUBSCRIPTION,
    }
    const processingAt = '2026-09-01T10:00:00.000Z'
    const paidAt = '2026-09-03T15:00:00.000Z'

    state = applyWebhookToStripeInfoState(state, 'payment_intent.processing', {
      customer: FIXTURE_CUSTOMER,
      id: 'pi_ach_processing',
      object: 'payment_intent',
      status: 'processing',
      payment_method_types: ['us_bank_account'],
    }, processingAt)

    state = applyWebhookToStripeInfoState(state, 'payment_intent.succeeded', {
      customer: FIXTURE_CUSTOMER,
      id: 'pi_ach_processing',
      object: 'payment_intent',
      status: 'succeeded',
      payment_method_types: ['us_bank_account'],
    }, paidAt)

    expect(state.status).toBe('created')
    expect(state.paid_at).toBeNull()
    expect(stripeEventTestUtils.hasStripePaidAccess(state)).toBe(false)
  })
})

describe('stripe ACH webhook production guards', () => {
  it.concurrent('requires invoice subscription to match stored subscription', () => {
    expect(stripeEventTestUtils.shouldApplyInvoiceToStoredSubscription('sub_a', 'sub_a')).toBe(true)
    expect(stripeEventTestUtils.shouldApplyInvoiceToStoredSubscription('sub_a', 'sub_b')).toBe(false)
    expect(stripeEventTestUtils.shouldApplyInvoiceToStoredSubscription(null, 'sub_a')).toBe(false)
  })

  it.concurrent('keeps legacy succeeded rows on subscription.updated', () => {
    expect(stripeEventTestUtils.resolveSubscriptionPersistedStatus(
      'updated',
      { status: 'succeeded', paid_at: null },
    )).toBe('succeeded')
  })

  it.concurrent('prefers positive subscription invoice lines over proration credits', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: {
          customer: FIXTURE_CUSTOMER,
          id: 'in_proration',
          object: 'invoice',
          status: 'paid',
          lines: {
            data: [
              {
                amount: -1000,
                parent: {
                  subscription_item_details: {
                    subscription: 'sub_old',
                  },
                },
                pricing: {
                  price_details: {
                    price: 'price_old',
                    product: 'prod_old',
                  },
                },
              },
              {
                amount: 2000,
                parent: {
                  subscription_item_details: {
                    subscription: FIXTURE_SUBSCRIPTION,
                  },
                },
                pricing: {
                  price_details: {
                    price: FIXTURE_PRICE,
                    product: FIXTURE_PRODUCT,
                  },
                },
              },
            ],
          },
        },
      },
      type: 'invoice.paid',
    } as any)

    expect(stripeData.data.subscription_id).toBe(FIXTURE_SUBSCRIPTION)
    expect(stripeData.data.price_id).toBe(FIXTURE_PRICE)
    expect(stripeData.data.product_id).toBe(FIXTURE_PRODUCT)
  })
})
