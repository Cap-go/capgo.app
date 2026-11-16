import type Stripe from 'stripe'

// Entirely fictional billing identity and amounts, safe for public visual examples.
export const exampleInvoice = {
  id: 'in_example', customer: 'cus_example', number: 'EXAMPLE1-00042',
  account_name: 'Capgo', account_country: 'EE', account_tax_ids: [],
  customer_name: 'Example Studio', customer_email: 'billing@example.com',
  customer_address: { line1: '123 Example Street', line2: null, city: 'Rome', state: null, postal_code: '00100', country: 'IT' },
  customer_tax_ids: [], customer_tax_exempt: 'none', status: 'open',
  created: 1793491200, due_date: 1793491200, effective_at: null,
  status_transitions: { finalized_at: 1793491200 },
  currency: 'eur', subtotal: 1200, subtotal_excluding_tax: 1200,
  total: 1464, total_excluding_tax: 1200, amount_due: 1464, amount_paid: 0, amount_remaining: 1464,
  amount_overpaid: 0, amount_shipping: 0, starting_balance: 0,
  pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0,
  total_discount_amounts: [], total_pretax_credit_amounts: [],
  total_taxes: [{ amount: 264, tax_behavior: 'exclusive', taxable_amount: 1200, taxability_reason: 'standard_rated', tax_rate_details: { tax_rate: 'txr_example' } }],
  custom_fields: [], description: null, footer: null,
} as unknown as Stripe.Invoice
export const exampleLines = [{ id: 'il_example', description: 'Solo', amount: 1200, quantity: 1, period: { start: 1793491200, end: 1796083200 }, pricing: { unit_amount_decimal: '1200' }, taxes: exampleInvoice.total_taxes }] as unknown as Stripe.InvoiceLineItem[]
export const exampleAccount = {
  company: { name: 'Digital shift OU', address: { line1: 'sepapaja tn 6', postal_code: '15551', city: 'Tallinn', country: 'EE' } },
  business_profile: { support_email: 'support@capgo.app' },
} as Stripe.Account
export const exampleRate = { id: 'txr_example', display_name: 'VAT - Italy', percentage: 22 } as Stripe.TaxRate
