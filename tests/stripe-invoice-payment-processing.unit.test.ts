import { describe, expect, it } from 'vitest'
import {
  shouldBlockPastDueForProcessingPayment,
  subscriptionInvoicePaymentStateFromInvoice,
} from '../supabase/functions/_backend/utils/stripe.ts'

describe('subscriptionInvoicePaymentStateFromInvoice', () => {
  it.concurrent('treats a processing open invoice as paid for access', () => {
    expect(subscriptionInvoicePaymentStateFromInvoice({ status: 'open', billing_reason: 'subscription_cycle' }, 'processing')).toBe('paid')
  })

  it.concurrent('keeps first invoice unpaid when still open', () => {
    expect(subscriptionInvoicePaymentStateFromInvoice({ status: 'open', billing_reason: 'subscription_create' }, null)).toBe('first_invoice_unpaid')
  })

  it.concurrent('stays unpaid when a renewal is open without a processing intent', () => {
    expect(subscriptionInvoicePaymentStateFromInvoice({ status: 'open', billing_reason: 'subscription_cycle' }, 'requires_payment_method')).toBe('unpaid')
  })
})

describe('shouldBlockPastDueForProcessingPayment', () => {
  it.concurrent('suppresses past due while payment is processing', () => {
    expect(shouldBlockPastDueForProcessingPayment(true)).toBe(true)
    expect(shouldBlockPastDueForProcessingPayment(false)).toBe(false)
  })
})