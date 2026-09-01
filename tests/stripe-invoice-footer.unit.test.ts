import { describe, expect, it } from 'vitest'
import { stripeEventTestUtils } from '../supabase/functions/_backend/triggers/stripe_event.ts'
import { extractDataEvent } from '../supabase/functions/_backend/utils/stripe_event.ts'

const mockContext = {
  get: () => 'test-request-id',
} as any

function makeInvoice({
  collectionMethod = 'send_invoice',
  footer,
  paymentMethodTypes = ['us_bank_account'],
  status = 'draft',
}: {
  collectionMethod?: 'charge_automatically' | 'send_invoice'
  footer?: string | null
  paymentMethodTypes?: string[]
  status?: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void'
}) {
  return {
    customer: 'cus_transfer_invoice',
    id: 'in_transfer_invoice',
    object: 'invoice',
    collection_method: collectionMethod,
    footer,
    payment_settings: {
      payment_method_types: paymentMethodTypes,
    },
    status,
  }
}

describe('transfer invoice footer helpers', () => {
  it.concurrent('treats send_invoice collection as a transfer invoice', () => {
    expect(stripeEventTestUtils.isTransferInvoice(makeInvoice({
      collectionMethod: 'send_invoice',
      paymentMethodTypes: ['card'],
    }))).toBe(true)
  })

  it.concurrent('treats bank-transfer payment method types as transfer invoices', () => {
    expect(stripeEventTestUtils.isTransferInvoice(makeInvoice({
      collectionMethod: 'charge_automatically',
      paymentMethodTypes: ['us_bank_account'],
    }))).toBe(true)
  })

  it.concurrent('does not treat card-only charge_automatically invoices as transfer invoices', () => {
    expect(stripeEventTestUtils.isTransferInvoice(makeInvoice({
      collectionMethod: 'charge_automatically',
      paymentMethodTypes: ['card'],
    }))).toBe(false)
  })

  it.concurrent('stamps draft transfer invoices without the OUR footer marker', () => {
    expect(stripeEventTestUtils.shouldStampTransferInvoiceFooter(makeInvoice({
      status: 'draft',
      footer: null,
    }))).toBe(true)
  })

  it.concurrent('skips finalized transfer invoices', () => {
    expect(stripeEventTestUtils.shouldStampTransferInvoiceFooter(makeInvoice({
      status: 'open',
    }))).toBe(false)
  })

  it.concurrent('skips draft card-only invoices', () => {
    expect(stripeEventTestUtils.shouldStampTransferInvoiceFooter(makeInvoice({
      collectionMethod: 'charge_automatically',
      paymentMethodTypes: ['card'],
      status: 'draft',
    }))).toBe(false)
  })

  it.concurrent('skips invoices that already contain the OUR footer marker', () => {
    expect(stripeEventTestUtils.shouldStampTransferInvoiceFooter(makeInvoice({
      footer: 'For US bank wires: instruct your bank to send OUR (sender pays all correspondent/intermediary fees) so the full invoice amount arrives. Do not use SHA/shared fees.',
      status: 'draft',
    }))).toBe(false)
  })

  it.concurrent('uses the exact transfer invoice footer copy', () => {
    expect(stripeEventTestUtils.TRANSFER_INVOICE_FOOTER).toBe(
      'For US bank wires: instruct your bank to send OUR (sender pays all correspondent/intermediary fees) so the full invoice amount arrives. Do not use SHA/shared fees.',
    )
  })

  it.concurrent('appends the transfer footer to an existing draft invoice footer', () => {
    const existingFooter = 'Include PO #12345 on the wire memo. Contact billing@example.com for tax forms.'
    expect(stripeEventTestUtils.buildTransferInvoiceFooter(existingFooter)).toBe(
      `${existingFooter}\n\n${stripeEventTestUtils.TRANSFER_INVOICE_FOOTER}`,
    )
  })

  it.concurrent('returns null when appending would exceed the Stripe footer length limit', () => {
    const existingFooter = 'x'.repeat(stripeEventTestUtils.TRANSFER_INVOICE_FOOTER_MAX_LENGTH)
    expect(stripeEventTestUtils.buildTransferInvoiceFooter(existingFooter)).toBeNull()
    expect(stripeEventTestUtils.shouldStampTransferInvoiceFooter(makeInvoice({
      footer: existingFooter,
      status: 'draft',
    }))).toBe(false)
  })
})

describe('invoice.created and invoice.updated webhook extraction', () => {
  it.concurrent('extracts customer_id from invoice.created events', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: makeInvoice({}),
      },
      type: 'invoice.created',
    } as any)

    expect(stripeData.data.customer_id).toBe('cus_transfer_invoice')
    expect(stripeData.data.status).toBe('updated')
  })

  it.concurrent('extracts customer_id from invoice.updated events', () => {
    const stripeData = extractDataEvent(mockContext, {
      data: {
        object: makeInvoice({ status: 'draft' }),
      },
      type: 'invoice.updated',
    } as any)

    expect(stripeData.data.customer_id).toBe('cus_transfer_invoice')
    expect(stripeData.data.status).toBe('updated')
  })
})
