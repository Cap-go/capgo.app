import type Stripe from 'stripe'
import type { InvoiceDocument } from '../../shared/invoice-document.ts'
import type { InAppBillingContext } from './stripe_in_app.ts'
import { BILLING_COUNTRIES } from '../../shared/billing-profile.ts'
import { stripeAmountToMajorUnits } from '../../shared/stripe-amount.ts'
import { simpleError } from './hono.ts'

function date(seconds: number) {
  return new Date(seconds * 1000).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' })
}

function address(value: Stripe.Address | null | undefined): string[] {
  if (!value)
    return []
  return [value.line1, value.line2, [value.postal_code, value.city, value.state].filter(Boolean).join(' '), value.country ? new Intl.DisplayNames(['en'], { type: 'region' }).of(value.country) : null].filter((line): line is string => !!line)
}

export function buildInvoiceDocument(invoice: Stripe.Invoice, account: Stripe.Account, lines: Stripe.InvoiceLineItem[], taxIds: Stripe.TaxId[], rates: Map<string, Stripe.TaxRate>): InvoiceDocument {
  if (!invoice.number || !invoice.status || invoice.status === 'draft')
    throw simpleError('invoice_not_finalized', 'The invoice is not finalized')
  const money = (amount: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: invoice.currency.toUpperCase(), currencyDisplay: 'symbol', maximumFractionDigits: 8 }).format(stripeAmountToMajorUnits(amount, invoice.currency))
  const totals: InvoiceDocument['totals'] = [{ label: 'Subtotal', amount: money(invoice.subtotal) }]
  for (const discount of invoice.total_discount_amounts ?? [])
    totals.push({ label: 'Discount', amount: money(-discount.amount) })
  for (const credit of invoice.total_pretax_credit_amounts ?? []) {
    if (credit.type !== 'discount')
      totals.push({ label: 'Pre-tax credit', amount: money(-credit.amount) })
  }
  if (invoice.total_excluding_tax != null && invoice.total_taxes?.length)
    totals.push({ label: 'Total excluding tax', amount: money(invoice.total_excluding_tax) })
  for (const tax of invoice.total_taxes ?? []) {
    const rate = rates.get(tax.tax_rate_details?.tax_rate ?? '')
    const label = [rate?.display_name ?? 'Tax', rate?.percentage != null ? `(${rate.percentage}%${tax.taxable_amount != null ? ` on ${money(tax.taxable_amount)}` : ''})` : '', tax.tax_behavior === 'inclusive' ? '(included)' : ''].filter(Boolean).join(' ')
    totals.push({ label, amount: money(tax.amount) })
  }
  if (invoice.amount_shipping)
    totals.push({ label: 'Shipping', amount: money(invoice.amount_shipping) })
  totals.push({ label: 'Total', amount: money(invoice.total) })
  if (invoice.starting_balance)
    totals.push({ label: 'Starting customer balance', amount: money(invoice.starting_balance) })
  if (invoice.pre_payment_credit_notes_amount || invoice.post_payment_credit_notes_amount)
    totals.push({ label: 'Credit notes', amount: money(-(invoice.pre_payment_credit_notes_amount + invoice.post_payment_credit_notes_amount)) })
  totals.push({ label: 'Amount due', amount: money(invoice.amount_due), strong: true })
  if (invoice.amount_paid || invoice.status === 'paid')
    totals.push({ label: 'Amount paid', amount: money(invoice.amount_paid) })
  if (invoice.amount_overpaid)
    totals.push({ label: 'Amount overpaid', amount: money(invoice.amount_overpaid) })
  if (invoice.amount_remaining !== invoice.amount_due)
    totals.push({ label: 'Amount remaining', amount: money(invoice.amount_remaining), strong: true })
  const notes = [invoice.footer].filter((line): line is string => !!line)
  if (invoice.customer_tax_exempt === 'reverse' || invoice.total_taxes?.some(tax => tax.taxability_reason === 'reverse_charge'))
    notes.push('Tax to be paid on reverse charge basis.')
  if (invoice.customer_tax_exempt === 'exempt')
    notes.push('Customer is tax exempt.')
  return {
    number: invoice.number,
    issued: date(invoice.effective_at ?? invoice.status_transitions.finalized_at ?? invoice.created),
    due: invoice.due_date ? date(invoice.due_date) : null,
    status: invoice.status,
    summary: invoice.status === 'paid'
      ? `${money(invoice.amount_paid)} paid${invoice.status_transitions.paid_at ? ` ${date(invoice.status_transitions.paid_at)}` : ''}`
      : invoice.status === 'void' ? 'Void' : invoice.status === 'uncollectible' ? 'Uncollectible' : `${money(invoice.amount_remaining)} due${invoice.due_date ? ` ${date(invoice.due_date)}` : ''}`,
    seller: [invoice.account_name ?? account.business_profile?.name ?? '', account.company?.name !== invoice.account_name ? account.company?.name ?? '' : '', ...address(account.company?.address ?? account.business_profile?.support_address), account.business_profile?.support_email ?? '', ...taxIds.map(tax => `${tax.type === 'eu_vat' ? `${tax.value?.slice(0, 2)} VAT` : tax.type.toUpperCase().replaceAll('_', ' ')} ${tax.value}`)].filter(Boolean),
    customer: [invoice.customer_name ?? '', ...address(invoice.customer_address), invoice.customer_email ?? '', ...invoice.customer_tax_ids?.map(tax => `${tax.type === 'eu_vat' ? `${tax.value?.slice(0, 2)} VAT` : tax.type.toUpperCase().replaceAll('_', ' ')} ${tax.value}`) ?? []].filter(Boolean),
    fields: invoice.custom_fields ?? [],
    description: invoice.description,
    lines: lines.map(line => ({
      description: line.description ?? 'Subscription',
      period: line.period ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }).formatRange(new Date(line.period.start * 1000), new Date(line.period.end * 1000)).replace(/\s*–\s*/g, '–') : '',
      quantity: line.quantity == null ? '' : String(line.quantity),
      unitPrice: line.pricing?.unit_amount_decimal != null ? money(Number(line.pricing.unit_amount_decimal)) : '',
      amount: money(line.amount),
      tax: (line.taxes ?? []).map((tax) => {
        const rate = rates.get(tax.tax_rate_details?.tax_rate ?? '')
        return rate?.percentage != null ? `${rate.percentage}%${tax.tax_behavior === 'inclusive' ? ' (incl.)' : ''}` : money(tax.amount)
      }).join('\n'),
    })),
    totals,
    notes,
  }
}

type InvoiceTaxId = NonNullable<Stripe.Invoice['customer_tax_ids']>[number]

function taxCountry(taxId: InvoiceTaxId) {
  if (taxId.type === 'eu_vat') {
    const prefix = taxId.value?.trim().slice(0, 2).toUpperCase()
    // Stripe's EU VAT type also covers EL (Greece) and XI (Northern Ireland).
    // https://docs.stripe.com/tax/invoicing/tax-ids
    if (prefix === 'EL')
      return 'GR'
    if (prefix === 'XI')
      return 'GB'
    return prefix && 'AT BE BG HR CY CZ DE DK EE ES FI FR GR HU IE IT LT LU LV MT NL PL PT RO SE SI SK'.split(' ').includes(prefix) ? prefix : null
  }
  const prefix = taxId.type.split('_')[0].toUpperCase()
  return BILLING_COUNTRIES.includes(prefix) ? prefix : null
}

function sameTaxJurisdiction(left: InvoiceTaxId, right: InvoiceTaxId) {
  const country = taxCountry(left)
  return !!country && left.type === right.type && country === taxCountry(right)
}

export function applySavedInvoiceDetails(invoice: Stripe.Invoice, customer: Stripe.Customer, savedTaxIds: InvoiceTaxId[]): Stripe.Invoice {
  const issuedCountry = invoice.customer_address?.country?.toUpperCase()
  const canUpdateAddress = !!issuedCountry && !!customer.address?.line1 && customer.address.country?.toUpperCase() === issuedCountry
  const issuedTaxIds = invoice.customer_tax_ids ?? []
  // Keep an issued ID unless a single replacement has the same tax type/country.
  // In particular, a removed ID or a changed billing country cannot rewrite history.
  const customerTaxIds = issuedTaxIds.length
    ? issuedTaxIds.map((issued) => {
        const candidates = savedTaxIds.filter(saved => sameTaxJurisdiction(issued, saved))
        if (candidates.some(saved => saved.value === issued.value))
          return issued
        const issuedInJurisdiction = issuedTaxIds.filter(other => sameTaxJurisdiction(issued, other))
        return candidates.length === 1 && issuedInJurisdiction.length === 1 ? candidates[0] : issued
      })
    : savedTaxIds.filter(saved => !!issuedCountry && taxCountry(saved) === issuedCountry)
  return {
    ...invoice,
    customer_name: customer.name?.trim() || invoice.customer_name,
    customer_address: canUpdateAddress && customer.address ? customer.address : invoice.customer_address,
    customer_tax_ids: customerTaxIds,
  }
}

export async function getInvoiceDocument(ctx: InAppBillingContext, invoiceId: unknown): Promise<InvoiceDocument> {
  if (typeof invoiceId !== 'string' || !/^in_[a-zA-Z0-9]+$/.test(invoiceId))
    throw simpleError('invalid_invoice', 'Invalid invoice')
  const invoice = await ctx.stripe.invoices.retrieve(invoiceId)
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id
  // Resolve the Stripe account from the authorized org, then check ownership before reading more data.
  if (customerId !== ctx.customerId)
    throw simpleError('not_authorized', 'Not authorized')
  if (!invoice.number || invoice.status === 'draft')
    throw simpleError('invoice_not_finalized', 'The invoice is not finalized')
  if (invoice.issuer?.type === 'account' || invoice.on_behalf_of)
    throw simpleError('unsupported_invoice_issuer', 'This invoice has a different issuer')
  const customer = await ctx.stripe.customers.retrieve(ctx.customerId)
  let documentInvoice: Stripe.Invoice = invoice
  if (!customer.deleted) {
    const customerTaxIds: InvoiceTaxId[] = []
    for await (const taxId of ctx.stripe.customers.listTaxIds(ctx.customerId, { limit: 100 })) {
      if (customerTaxIds.length >= 100)
        throw simpleError('too_many_billing_tax_ids', 'Contact support to download this invoice')
      customerTaxIds.push({ type: taxId.type, value: taxId.value })
    }
    documentInvoice = applySavedInvoiceDetails(invoice, customer, customerTaxIds)
  }
  const lines: Stripe.InvoiceLineItem[] = []
  for await (const line of ctx.stripe.invoices.listLineItems(invoiceId, { limit: 100 })) {
    if (lines.length >= 1000)
      throw simpleError('invoice_too_large', 'Contact support to download this invoice')
    lines.push(line)
  }
  const [account, taxIds, rates] = await Promise.all([
    ctx.stripe.accounts.retrieve(null),
    Promise.all((invoice.account_tax_ids ?? []).map(tax => typeof tax === 'string' ? ctx.stripe.taxIds.retrieve(tax) : tax)),
    Promise.all([...new Set([...(invoice.total_taxes ?? []), ...lines.flatMap(line => line.taxes ?? [])].map(tax => tax.tax_rate_details?.tax_rate).filter((id): id is string => !!id))].map(id => ctx.stripe.taxRates.retrieve(id))),
  ])
  return buildInvoiceDocument(documentInvoice, account, lines, taxIds.filter((tax): tax is Stripe.TaxId => !tax.deleted), new Map(rates.map(rate => [rate.id, rate])))
}
