import type Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'
import { AUTO_TOP_UP_KIND, normalizeAutoTopUpMonthlyLimit, payAutoTopUpInvoice, shouldAttemptAutoTopUp } from '../supabase/functions/_backend/utils/credit_auto_top_up.ts'

describe('credit auto top-up decision', () => {
  const base = { enabled: true, availableCredits: 0, threshold: 10, lastAttemptAt: null as string | null }
  const now = Date.parse('2026-08-24T12:00:00.000Z')
  it.concurrent.each([
    ['does not attempt when disabled', { enabled: false }, false],
    ['does not attempt when available credits are at the threshold', { availableCredits: 10 }, false],
    ['does not attempt below the $10 minimum threshold', { threshold: 9 }, false],
    ['attempts when enabled, below threshold, and off cooldown', { availableCredits: 3 }, true],
    ['does not attempt during the cooldown window', { lastAttemptAt: '2026-08-24T11:30:00.000Z', now }, false],
    ['attempts again after the cooldown window ends', { lastAttemptAt: '2026-08-24T10:59:00.000Z', now }, true],
    ['attempts when the last attempt timestamp is unparsable', { lastAttemptAt: 'not-a-date' }, true],
    ['ignores the monthly limit when it is 0', { monthlyLimit: 0, monthlyTotal: 1000 }, true],
    ['attempts while the next charge fits in the monthly limit', { monthlyLimit: 30, monthlyTotal: 20 }, true],
    ['stops when the next charge would exceed the monthly limit', { monthlyLimit: 25, monthlyTotal: 20 }, false],
  ])('%s', (_label, overrides, expected) => {
    expect(shouldAttemptAutoTopUp({ ...base, ...overrides })).toBe(expected)
  })
})

describe('credit auto top-up monthly limit validation', () => {
  it.concurrent('accepts 0 as no limit', () => {
    expect(normalizeAutoTopUpMonthlyLimit(0, 10)).toBe(0)
  })

  it.concurrent('accepts a limit at least equal to the top-up amount', () => {
    expect(normalizeAutoTopUpMonthlyLimit(10, 10)).toBe(10)
    expect(normalizeAutoTopUpMonthlyLimit('100.7', 25)).toBe(100)
  })

  it.concurrent('rejects negative, non-finite, or too-small limits', () => {
    expect(normalizeAutoTopUpMonthlyLimit(-1, 10)).toBeNull()
    expect(normalizeAutoTopUpMonthlyLimit(Number.POSITIVE_INFINITY, 10)).toBeNull()
    expect(normalizeAutoTopUpMonthlyLimit('abc', 10)).toBeNull()
    expect(normalizeAutoTopUpMonthlyLimit(5, 10)).toBeNull()
    expect(normalizeAutoTopUpMonthlyLimit(1_000_000_000_000, 10)).toBeNull()
  })

  it.concurrent('rejects malformed values instead of treating them as no limit', () => {
    expect(normalizeAutoTopUpMonthlyLimit(null, 10)).toBeNull()
    expect(normalizeAutoTopUpMonthlyLimit(false, 10)).toBeNull()
    expect(normalizeAutoTopUpMonthlyLimit('', 10)).toBeNull()
    expect(normalizeAutoTopUpMonthlyLimit('  ', 10)).toBeNull()
  })
})

describe('credit auto top-up invoice', () => {
  const context = { get: () => 'request-id' } as any
  const input = {
    orgId: 'org_1',
    customerId: 'cus_1',
    quantity: 25,
    productId: 'prod_credits',
    priceId: 'price_credits',
    paymentMethodId: 'pm_1',
    automaticTax: true,
  }

  function fakeStripe(payResult: 'paid' | 'declined') {
    const state: { status: string } = { status: 'draft' }
    const payments = { data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_1' } }] }
    const stripe = {
      invoices: {
        create: vi.fn(async () => ({ id: 'in_1', status: 'draft' })),
        finalizeInvoice: vi.fn(async () => Object.assign(state, { status: 'open', id: 'in_1', payments })),
        pay: vi.fn(async () => {
          if (payResult === 'declined')
            throw new Error('card_declined')
          return Object.assign(state, { status: 'paid' })
        }),
        retrieve: vi.fn(async () => ({ id: 'in_1', ...state })),
        voidInvoice: vi.fn(async () => Object.assign(state, { status: 'void' })),
        del: vi.fn(async () => ({ id: 'in_1', deleted: true })),
      },
      invoiceItems: { create: vi.fn(async () => ({ id: 'ii_1' })) },
      paymentIntents: { update: vi.fn(async () => ({ id: 'pi_1' })) },
    } as unknown as Stripe
    return stripe as any
  }

  it('bills the top-up through a paid invoice and tags its PaymentIntent', async () => {
    const stripe = fakeStripe('paid')
    await expect(payAutoTopUpInvoice(context, stripe, input)).resolves.toBe('pi_1')

    expect(stripe.invoices.create).toHaveBeenCalledWith(expect.objectContaining({
      customer: 'cus_1',
      automatic_tax: { enabled: true },
      pending_invoice_items_behavior: 'exclude',
      metadata: expect.objectContaining({ kind: AUTO_TOP_UP_KIND, orgId: 'org_1', intendedQuantity: '25' }),
    }), expect.anything())
    expect(stripe.invoiceItems.create).toHaveBeenCalledWith(expect.objectContaining({
      invoice: 'in_1',
      pricing: { price: 'price_credits' },
      quantity: 25,
    }), expect.anything())
    expect(stripe.paymentIntents.update).toHaveBeenCalledWith('pi_1', { metadata: expect.objectContaining({ kind: AUTO_TOP_UP_KIND }) })
    expect(stripe.invoices.pay).toHaveBeenCalledWith('in_1', expect.objectContaining({ payment_method: 'pm_1', off_session: true }))
    expect(stripe.invoices.voidInvoice).not.toHaveBeenCalled()
  })

  it('voids the invoice when the card is declined', async () => {
    const stripe = fakeStripe('declined')
    await expect(payAutoTopUpInvoice(context, stripe, input)).resolves.toBeNull()
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledWith('in_1')
  })
})
