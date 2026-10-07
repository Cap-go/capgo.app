import { describe, expect, it } from 'vitest'
import { stripeEventTestUtils } from '../supabase/functions/_backend/triggers/stripe_event.ts'
import { isSubscriptionInvoice, pickLatestSubscriptionInvoice, toOpenSubscriptionInvoiceSummary } from '../supabase/functions/_backend/utils/stripe.ts'
import { extractDataEvent } from '../supabase/functions/_backend/utils/stripe_event.ts'

const mockContext = {
  get: () => 'test-request-id',
} as any

function makeInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'in_test_dunning',
    object: 'invoice',
    customer: 'cus_test_dunning',
    amount_due: 1400,
    amount_remaining: 1400,
    attempt_count: 2,
    billing_reason: 'subscription_cycle',
    created: 1_760_000_000,
    currency: 'usd',
    hosted_invoice_url: 'https://invoice.stripe.com/i/test_dunning',
    next_payment_attempt: 1_760_259_200,
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_test_dunning' } },
    ...overrides,
  } as any
}

describe('open subscription invoice helpers', () => {
  it.concurrent('detects subscription invoices from parent or billing reason', () => {
    expect(isSubscriptionInvoice(makeInvoice())).toBe(true)
    expect(isSubscriptionInvoice(makeInvoice({ parent: null, billing_reason: 'subscription_create' }))).toBe(true)
    expect(isSubscriptionInvoice(makeInvoice({ parent: null, billing_reason: 'manual' }))).toBe(false)
  })

  it.concurrent('picks the newest subscription invoice and ignores one-off invoices', () => {
    const older = makeInvoice({ id: 'in_older', created: 1_750_000_000 })
    const newer = makeInvoice({ id: 'in_newer', created: 1_760_000_000 })
    const manual = makeInvoice({ id: 'in_manual', created: 1_770_000_000, parent: null, billing_reason: 'manual' })
    expect(pickLatestSubscriptionInvoice([older, manual, newer])?.id).toBe('in_newer')
    expect(pickLatestSubscriptionInvoice([manual])).toBeNull()
    expect(pickLatestSubscriptionInvoice([])).toBeNull()
  })

  it.concurrent('maps only the public pay-link fields', () => {
    expect(toOpenSubscriptionInvoiceSummary(makeInvoice({ amount_remaining: 900 }))).toEqual({
      hosted_invoice_url: 'https://invoice.stripe.com/i/test_dunning',
      amount_due: 900,
      currency: 'usd',
      attempt_count: 2,
      next_payment_attempt: new Date(1_760_259_200 * 1000).toISOString(),
    })
    expect(toOpenSubscriptionInvoiceSummary(makeInvoice({ next_payment_attempt: null, hosted_invoice_url: undefined })).next_payment_attempt).toBeNull()
  })
})

describe('dunning bento payload', () => {
  it.concurrent('adds the hosted invoice link and retry info to the failed payment event', () => {
    const summary = toOpenSubscriptionInvoiceSummary(makeInvoice())
    expect(stripeEventTestUtils.buildDunningInvoiceBentoData(summary)).toEqual({
      hosted_invoice_url: 'https://invoice.stripe.com/i/test_dunning',
      attempt_count: 2,
      next_payment_attempt: summary.next_payment_attempt,
      amount: 14,
      currency: 'usd',
    })
  })

  it.concurrent('keeps the failed payment event payload empty without an open invoice', () => {
    expect(stripeEventTestUtils.buildDunningInvoiceBentoData(null)).toEqual({})
  })

  it.concurrent('uses a dedicated event for payment action required', () => {
    expect(stripeEventTestUtils.BENTO_PAYMENT_ACTION_REQUIRED_EVENT).toBe('org:payment_action_required')
  })
})

describe('invoice.payment_action_required parsing', () => {
  it.concurrent('extracts the customer without a subscription state change', () => {
    const stripeData = extractDataEvent(mockContext, {
      type: 'invoice.payment_action_required',
      data: { object: makeInvoice() },
    } as any)
    expect(stripeData.data.customer_id).toBe('cus_test_dunning')
    expect(stripeData.data.status).toBe('updated')
    expect(stripeData.data.price_id).toBeUndefined()
    expect(stripeData.data.product_id).toBeUndefined()
  })
})
