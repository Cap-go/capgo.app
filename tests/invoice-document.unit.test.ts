import type Stripe from 'stripe'
import type { InAppBillingContext } from '../supabase/functions/_backend/utils/stripe_in_app'
import { describe, expect, it, vi } from 'vitest'
import { buildInvoiceDocument, getInvoiceDocument, parseInvoiceBillingDetails } from '../supabase/functions/_backend/utils/invoice_document'
import { exampleAccount, exampleInvoice, exampleLines, exampleRate } from './fixtures/invoices/example'

function document(overrides: Partial<Stripe.Invoice> = {}) {
  return buildInvoiceDocument({ ...exampleInvoice, ...overrides }, exampleAccount, exampleLines, [], new Map([[exampleRate.id, exampleRate]]))
}
function context(invoice = exampleInvoice, lines = exampleLines) {
  const stripe = {
    invoices: { retrieve: vi.fn().mockResolvedValue(invoice), listLineItems: vi.fn().mockImplementation(async function* () { yield* lines }) },
    customers: { retrieve: vi.fn().mockResolvedValue({ id: 'cus_example', name: 'Updated Example Company', address: { line1: '456 Example Avenue', line2: null, city: 'Paris', state: null, postal_code: '75001', country: 'FR' } }), listTaxIds: vi.fn().mockImplementation(async function* () { yield { type: 'eu_vat', value: 'FR00000000000' } }), update: vi.fn() },
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
    expect(result.totals).toContainEqual({ label: 'VAT - Italy (22% on €12.00)', amount: '€2.64' })
    expect(result.totals).toContainEqual({ label: 'Total', amount: '€14.64' })
    expect(JSON.stringify(result)).not.toMatch(/cus_|in_example|stripe.com/)
  })
  it.concurrent.each(['ABC12345-0001', 'EXAMPLE1-00042'])('preserves each account numbering format %s exactly', (number) => {
    expect(document({ number }).number).toBe(number)
  })
  it.concurrent('does not infer reverse charge from a tax ID alone', () => {
    expect(document({ customer_tax_ids: [{ type: 'eu_vat', value: 'EXAMPLE' }] }).notes).toEqual([])
    expect(document({ customer_tax_exempt: 'reverse' }).notes).toContain('Tax to be paid on reverse charge basis.')
  })
  it.concurrent.each([['jpy', '¥1,464'], ['kwd', 'KWD 1.464'], ['isk', 'ISK 14.64']])('formats Stripe units for %s', (currency, expected) => {
    expect(document({ currency }).totals.find(row => row.label === 'Total')?.amount).toBe(expected)
  })
  it.concurrent('shows discounts, credits, and partial payment separately without recalculating totals', () => {
    const result = document({ total_discount_amounts: [{ amount: 200, discount: 'di_example' }], starting_balance: -100, post_payment_credit_notes_amount: 50, amount_paid: 400, amount_remaining: 914 })
    expect(result.totals).toEqual(expect.arrayContaining([
      { label: 'Discount', amount: '-€2.00' },
      { label: 'Credit notes', amount: '-€0.50' },
      { label: 'Amount paid', amount: '€4.00' },
      { label: 'Amount remaining', amount: '€9.14', strong: true },
    ]))
  })
  it.concurrent('shows line tax and compact totals for an unpaid invoice, retaining partial payment details', () => {
    const result = document()
    expect(result.lines[0].tax).toBe('22%')
    expect(result.lines[0].period).toBe('Nov 1–Dec 1, 2026')
    expect(result.totals.map(row => row.label)).toEqual(['Subtotal', 'Total excluding tax', 'VAT - Italy (22% on €12.00)', 'Total', 'Amount due'])
    expect(document({ status: 'paid', amount_paid: 1464, amount_remaining: 0 }).totals).toEqual(expect.arrayContaining([
      { label: 'Amount paid', amount: '€14.64' },
      { label: 'Amount remaining', amount: '€0.00', strong: true },
    ]))
  })
  it.concurrent('resolves line-specific tax rates even when absent from aggregate taxes', async () => {
    const { ctx, stripe } = context({ ...exampleInvoice, total_taxes: [] })
    const result = await getInvoiceDocument(ctx, 'in_example')
    expect(stripe.taxRates.retrieve).toHaveBeenCalledWith('txr_example')
    expect(result.lines[0].tax).toBe('22%')
  })
  it.concurrent('regenerates the saved billing identity including VAT number without changing issued tax treatment or amounts', async () => {
    const invoice = { ...exampleInvoice, customer_tax_ids: [{ type: 'eu_vat' as const, value: 'IT00000000000' }] }
    const { ctx, stripe } = context(invoice)
    const issued = await getInvoiceDocument(ctx, 'in_example')
    expect(stripe.customers.retrieve).not.toHaveBeenCalled()
    expect(stripe.customers.listTaxIds).not.toHaveBeenCalled()
    const current = await getInvoiceDocument(ctx, 'in_example', 'current')
    expect(stripe.customers.retrieve).toHaveBeenCalledWith('cus_example')
    expect(current.customer).toEqual(['Updated Example Company', '456 Example Avenue', '75001 Paris', 'France', 'billing@example.com', 'FR VAT FR00000000000'])
    expect(stripe.customers.listTaxIds).toHaveBeenCalledWith('cus_example', { limit: 100 })
    expect(invoice.customer_tax_ids).toEqual([{ type: 'eu_vat', value: 'IT00000000000' }])
    expect({ ...current, customer: [] }).toEqual({ ...issued, customer: [] })
    expect(stripe.customers.update).not.toHaveBeenCalled()
    expect(invoice.customer_address).toEqual(exampleInvoice.customer_address)
    expect((await getInvoiceDocument(ctx, 'in_example')).customer).toEqual(issued.customer)
  })
  it.concurrent('rejects current-details requests before reading a different customer profile', async () => {
    const { ctx, stripe } = context({ ...exampleInvoice, customer: 'cus_other' })
    await expect(getInvoiceDocument(ctx, 'in_example', 'current')).rejects.toThrow()
    expect(stripe.customers.retrieve).not.toHaveBeenCalled()
    expect(stripe.customers.listTaxIds).not.toHaveBeenCalled()
  })
  it.concurrent.each([{ deleted: true }, { address: null }, { address: { line1: '456 Example Avenue' } }])('rejects unavailable or incomplete current billing addresses', async (customer) => {
    const { ctx, stripe } = context()
    stripe.customers.retrieve.mockResolvedValue(customer)
    await expect(getInvoiceDocument(ctx, 'in_example', 'current')).rejects.toThrow()
    expect(stripe.invoices.listLineItems).not.toHaveBeenCalled()
  })
  it.concurrent('reflects removed tax IDs without changing the original invoice or its reverse-charge treatment', async () => {
    const invoice = { ...exampleInvoice, customer_tax_ids: [{ type: 'eu_vat' as const, value: 'IT00000000000' }], customer_tax_exempt: 'reverse' as const }
    const { ctx, stripe } = context(invoice)
    stripe.customers.listTaxIds.mockImplementation(async function* () {})
    const current = await getInvoiceDocument(ctx, 'in_example', 'current')
    expect(current.customer).not.toContain('IT VAT IT00000000000')
    expect(current.notes).toContain('Tax to be paid on reverse charge basis.')
    expect((await getInvoiceDocument(ctx, 'in_example')).customer).toContain('IT VAT IT00000000000')
  })
  it.concurrent('reads every saved tax ID and fails explicitly if the bounded list is exceeded', async () => {
    const { ctx, stripe } = context()
    stripe.customers.listTaxIds.mockImplementation(async function* () {
      yield { type: 'eu_vat', value: 'FR00000000000' }
      yield { type: 'gb_vat', value: 'GB000000000' }
    })
    expect((await getInvoiceDocument(ctx, 'in_example', 'current')).customer).toEqual(expect.arrayContaining(['FR VAT FR00000000000', 'GB VAT GB000000000']))
    stripe.customers.listTaxIds.mockImplementation(async function* () {
      for (let i = 0; i < 101; i++)
        yield { type: 'eu_vat', value: `EXAMPLE${i}` }
    })
    await expect(getInvoiceDocument(ctx, 'in_example', 'current')).rejects.toThrow()
  })
  it.concurrent('does not fall back to the old VAT number when current tax IDs cannot be read', async () => {
    const { ctx, stripe } = context()
    stripe.customers.listTaxIds.mockImplementation(() => { throw new Error('Stripe unavailable') })
    await expect(getInvoiceDocument(ctx, 'in_example', 'current')).rejects.toThrow('Stripe unavailable')
  })
  it.concurrent('defaults to issued details and rejects unsupported selectors', () => {
    expect(parseInvoiceBillingDetails(undefined)).toBe('issued')
    expect(parseInvoiceBillingDetails('current')).toBe('current')
    for (const value of [true, null, {}, 'another-customer'])
      expect(() => parseInvoiceBillingDetails(value)).toThrow()
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
