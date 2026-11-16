import type Stripe from 'stripe'
import type { InAppBillingContext } from '../supabase/functions/_backend/utils/stripe_in_app'
import { describe, expect, it, vi } from 'vitest'
import { buildInvoiceDocument, getInvoiceDocument } from '../supabase/functions/_backend/utils/invoice_document'
import { exampleAccount, exampleInvoice, exampleLines, exampleRate } from './fixtures/invoices/example'

function document(overrides: Partial<Stripe.Invoice> = {}) {
  return buildInvoiceDocument({ ...exampleInvoice, ...overrides }, exampleAccount, exampleLines, [], new Map([[exampleRate.id, exampleRate]]))
}
function context(invoice = exampleInvoice, lines = exampleLines) {
  const stripe = {
    invoices: { retrieve: vi.fn().mockResolvedValue(invoice), listLineItems: vi.fn().mockImplementation(async function* () { yield* lines }) },
    accounts: { retrieve: vi.fn().mockResolvedValue(exampleAccount) },
    taxIds: { retrieve: vi.fn() },
    taxRates: { retrieve: vi.fn().mockResolvedValue(exampleRate) },
  }
  return { stripe, ctx: { stripe, customerId: 'cus_example', billingAccount: 'ee' } as unknown as InAppBillingContext }
}

describe('owned invoice documents', () => {
  it.concurrent('retains the finalized number and customer snapshot without exposing Stripe payment links', () => {
    const result = document()
    expect(result.number).toBe('EXAMPLE1-00042')
    expect(result.customer).toContain('billing@example.com')
    expect(result.totals).toContainEqual({ label: 'VAT - Italy (22%)', amount: 'EUR 2.64' })
    expect(result.totals).toContainEqual({ label: 'Total', amount: 'EUR 14.64', strong: true })
    expect(JSON.stringify(result)).not.toMatch(/cus_|in_example|stripe.com/)
  })
  it.concurrent.each(['ABC12345-0001', 'EXAMPLE1-00042'])('preserves each account numbering format %s exactly', (number) => {
    expect(document({ number }).number).toBe(number)
  })
  it.concurrent('does not infer reverse charge from a tax ID alone', () => {
    expect(document({ customer_tax_ids: [{ type: 'eu_vat', value: 'EXAMPLE' }] }).notes).toEqual([])
    expect(document({ customer_tax_exempt: 'reverse' }).notes).toContain('Tax to be paid on reverse charge basis.')
  })
  it.concurrent.each([['jpy', 'JPY 1,464'], ['kwd', 'KWD 1.464'], ['isk', 'ISK 14.64']])('formats Stripe units for %s', (currency, expected) => {
    expect(document({ currency }).totals.find(row => row.label === 'Total')?.amount).toBe(expected)
  })
  it.concurrent('shows discounts, credits, and partial payment separately without recalculating totals', () => {
    const result = document({ total_discount_amounts: [{ amount: 200, discount: 'di_example' }], starting_balance: -100, post_payment_credit_notes_amount: 50, amount_paid: 400, amount_remaining: 914 })
    expect(result.totals).toEqual(expect.arrayContaining([
      { label: 'Discount', amount: '-EUR 2.00' },
      { label: 'Credit notes', amount: '-EUR 0.50' },
      { label: 'Amount paid', amount: 'EUR 4.00' },
      { label: 'Amount remaining', amount: 'EUR 9.14', strong: true },
    ]))
  })
  it.concurrent('fetches every line rather than the first embedded Stripe page', async () => {
    const lines = Array.from({ length: 101 }, (_, i) => ({ ...exampleLines[0], id: `il_${i}` }))
    const { ctx, stripe } = context(exampleInvoice, lines)
    expect((await getInvoiceDocument(ctx, 'in_example')).lines).toHaveLength(101)
    expect(stripe.invoices.listLineItems).toHaveBeenCalledWith('in_example', { limit: 100 })
  })
  it.concurrent('checks ownership before fetching line items or seller information', async () => {
    const { ctx, stripe } = context({ ...exampleInvoice, customer: 'cus_other' })
    await expect(getInvoiceDocument(ctx, 'in_example')).rejects.toThrow()
    expect(stripe.accounts.retrieve).not.toHaveBeenCalled()
    expect(stripe.invoices.listLineItems).not.toHaveBeenCalled()
  })
  it.concurrent.each([{ status: 'draft' as const }, { number: null }])('rejects unnumbered and draft documents', async (overrides) => {
    const { ctx } = context({ ...exampleInvoice, ...overrides })
    await expect(getInvoiceDocument(ctx, 'in_example')).rejects.toThrow()
  })
  it.concurrent('bounds unexpectedly large invoices instead of returning a truncated PDF', async () => {
    const { ctx } = context(exampleInvoice, Array.from({ length: 1001 }, () => exampleLines[0]))
    await expect(getInvoiceDocument(ctx, 'in_example')).rejects.toThrow()
  })
})
