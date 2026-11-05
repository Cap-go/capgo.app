import type Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'
import { findInvoiceForCharge, isSubscriptionCharge } from '../supabase/functions/_backend/utils/stripe.ts'

function stripeWithInvoice(invoice: Partial<Stripe.Invoice> | null) {
  const list = vi.fn(async () => ({ data: invoice ? [{ invoice }] : [] }))
  return { stripe: { invoicePayments: { list } } as unknown as Stripe, list }
}

describe('isSubscriptionCharge', () => {
  it('treats a failed subscription invoice charge as a subscription failure', async () => {
    const { stripe, list } = stripeWithInvoice({ billing_reason: 'subscription_cycle', parent: null })
    expect(await isSubscriptionCharge(stripe, { payment_intent: 'pi_renewal' })).toBe(true)
    expect(list).toHaveBeenCalledWith({
      payment: { type: 'payment_intent', payment_intent: 'pi_renewal' },
      limit: 1,
      expand: ['data.invoice'],
    })
  })

  it('ignores credit auto top-ups and other charges without an invoice', async () => {
    const { stripe } = stripeWithInvoice(null)
    expect(await isSubscriptionCharge(stripe, { payment_intent: 'pi_top_up' })).toBe(false)
  })

  it('ignores one-off invoices', async () => {
    const { stripe } = stripeWithInvoice({ billing_reason: 'manual', parent: null })
    expect(await isSubscriptionCharge(stripe, { payment_intent: { id: 'pi_manual' } as Stripe.PaymentIntent })).toBe(false)
  })

  it('keeps the previous behavior for legacy charges without a PaymentIntent', async () => {
    const { stripe, list } = stripeWithInvoice(null)
    expect(await isSubscriptionCharge(stripe, { payment_intent: null })).toBe(true)
    expect(list).not.toHaveBeenCalled()
  })

  it('lets Stripe errors fail the webhook so it is retried', async () => {
    const stripe = { invoicePayments: { list: vi.fn(async () => { throw new Error('stripe down') }) } } as unknown as Stripe
    await expect(isSubscriptionCharge(stripe, { payment_intent: 'pi_x' })).rejects.toThrow('stripe down')
  })
})

describe('findInvoiceForCharge', () => {
  it('returns the invoice the failed charge was for', async () => {
    const { stripe } = stripeWithInvoice({ id: 'in_failed', status: 'open', billing_reason: 'subscription_cycle', parent: null })
    expect(await findInvoiceForCharge(stripe, { payment_intent: 'pi_renewal' })).toMatchObject({ id: 'in_failed' })
  })

  it('looks up the same charge only once per webhook', async () => {
    const { stripe, list } = stripeWithInvoice({ id: 'in_failed', status: 'open', billing_reason: 'subscription_cycle', parent: null })
    const charge = { payment_intent: 'pi_renewal' }
    expect(await isSubscriptionCharge(stripe, charge)).toBe(true)
    expect(await findInvoiceForCharge(stripe, charge)).toMatchObject({ id: 'in_failed' })
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('returns nothing for legacy charges without a PaymentIntent', async () => {
    const { stripe, list } = stripeWithInvoice(null)
    expect(await findInvoiceForCharge(stripe, { payment_intent: null })).toBeNull()
    expect(list).not.toHaveBeenCalled()
  })
})
