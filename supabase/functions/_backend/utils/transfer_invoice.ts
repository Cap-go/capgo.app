// Yearly bank transfer subscriptions are created in Capgo with this metadata.
// Manually invoiced customers do not have it, and keep access before the wire lands.
export const BANK_TRANSFER_METADATA_KEY = 'capgo_bank_transfer'
export const BANK_TRANSFER_DAYS_UNTIL_DUE = 30

const BANK_TRANSFER_CURRENCIES = new Set(['eur', 'gbp', 'jpy', 'mxn', 'usd'])

export function isBankTransferCurrency(currency: string) {
  return BANK_TRANSFER_CURRENCIES.has(currency.toLowerCase())
}

export function isSelfServeBankTransfer(metadata: Record<string, string> | null | undefined) {
  return metadata?.[BANK_TRANSFER_METADATA_KEY] === '1'
}

// Trials and invoices Capgo sent by hand stay active before payment.
// A bank transfer started from the plans page does not.
export function invoicedSubscriptionGrantsAccessBeforePayment(subscription: {
  status?: string | null
  collection_method?: string | null
  metadata?: Record<string, string> | null
}) {
  if (subscription.status === 'trialing')
    return true
  if (subscription.collection_method !== 'send_invoice')
    return false
  return !isSelfServeBankTransfer(subscription.metadata)
}

export const TRANSFER_INVOICE_FOOTER = 'For US bank wires: instruct your bank to send OUR (sender pays all correspondent/intermediary fees) so the full invoice amount arrives. Do not use SHA/shared fees.'
export const TRANSFER_INVOICE_FOOTER_MARKER = 'OUR (sender pays all correspondent'
export const TRANSFER_INVOICE_FOOTER_MAX_LENGTH = 5000

const TRANSFER_INVOICE_PAYMENT_METHOD_TYPES = new Set([
  'customer_balance',
  'ach_credit_transfer',
])

interface TransferInvoiceShape {
  collection_method?: string | null
  payment_settings?: {
    payment_method_types?: string[] | null
  } | null
}

type TransferInvoiceFooterShape = TransferInvoiceShape & {
  footer?: string | null
  status?: string | null
}

export function isTransferInvoice(invoice: TransferInvoiceShape) {
  if (invoice.collection_method === 'send_invoice')
    return true

  const paymentMethodTypes = invoice.payment_settings?.payment_method_types ?? []
  return paymentMethodTypes.some(type => TRANSFER_INVOICE_PAYMENT_METHOD_TYPES.has(type))
}

export function buildTransferInvoiceFooter(existingFooter?: string | null) {
  const trimmedExisting = existingFooter?.trim()
  if (!trimmedExisting)
    return TRANSFER_INVOICE_FOOTER

  const combined = `${trimmedExisting}\n\n${TRANSFER_INVOICE_FOOTER}`
  if (combined.length > TRANSFER_INVOICE_FOOTER_MAX_LENGTH)
    return null

  return combined
}

export function getTransferInvoiceFooterUpdate(
  invoice: TransferInvoiceFooterShape,
) {
  if (!shouldStampTransferInvoiceFooter(invoice))
    return null

  return buildTransferInvoiceFooter(invoice.footer)
}

export function shouldStampTransferInvoiceFooter(
  invoice: TransferInvoiceFooterShape,
) {
  if (invoice.status !== 'draft')
    return false
  if (!isTransferInvoice(invoice))
    return false
  if (invoice.footer?.includes(TRANSFER_INVOICE_FOOTER_MARKER))
    return false
  return buildTransferInvoiceFooter(invoice.footer) !== null
}
