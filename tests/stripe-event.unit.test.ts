import { describe, expect, it, vi } from 'vitest'
import { stripeEventTestUtils } from '../supabase/functions/_backend/triggers/stripe_event.ts'
import { orgEmailNotificationTestUtils } from '../supabase/functions/_backend/utils/org_email_notifications.ts'
import { buildExtraMauTiers, getExtraMau, isExtraMauPrice, isSubscriptionInvoice, normalizeStripeCountryCode, toOpenSubscriptionInvoiceSummary } from '../supabase/functions/_backend/utils/stripe.ts'
import { extractDataEvent, getStripeCustomerEmailFromEvent, normalizeBillingEmail } from '../supabase/functions/_backend/utils/stripe_event.ts'
import { stripeAmountToMajorUnits } from '../supabase/functions/shared/stripe-amount.ts'

const mockContext = {
  get: () => 'test-request-id',
} as any

const TRANSFER_FOOTER = 'For US bank wires: instruct your bank to send OUR (sender pays all correspondent/intermediary fees) so the full invoice amount arrives. Do not use SHA/shared fees.'

function makeCustomerEvent(type: 'customer.created' | 'customer.updated', customer: Record<string, unknown> = {}) {
  return {
    created: 1_711_925_200,
    data: { object: { id: 'cus_billing_email', object: 'customer', ...customer } },
    type,
  } as any
}

function makeDunningInvoice(overrides: Record<string, unknown> = {}) {
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

function makeTransferInvoice({
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
    payment_settings: { payment_method_types: paymentMethodTypes },
    status,
  }
}

describe('extractDataEvent customer extraction', () => {
  const charge = (customer: unknown) => ({ customer, id: 'ch_test', object: 'charge' })
  it.concurrent.each([
    ['charge.succeeded', charge('cus_charge_ok'), 'cus_charge_ok', 'succeeded'],
    ['charge.failed', charge('cus_charge_fail'), 'cus_charge_fail', 'failed'],
    ['charge.succeeded', charge(null), '', undefined],
    ['charge.failed', charge(null), '', undefined],
    ['charge.succeeded', charge({ id: 'cus_expanded', object: 'customer' }), 'cus_expanded', undefined],
    ['charge.refunded', { customer: 'cus_refund_test', id: 'ch_refund_test' }, 'cus_refund_test', undefined],
    ['customer.updated', { id: 'cus_country_sync', object: 'customer' }, 'cus_country_sync', 'updated'],
    ['invoice.created', makeTransferInvoice({}), 'cus_transfer_invoice', 'updated'],
    ['invoice.updated', makeTransferInvoice({ status: 'draft' }), 'cus_transfer_invoice', 'updated'],
  ])('extracts the customer from %s (%#)', (type, object, customerId, status) => {
    const { data } = extractDataEvent(mockContext, { created: 1_711_925_200, data: { object }, type } as any)
    expect(data.customer_id).toBe(customerId)
    if (status)
      expect(data.status).toBe(status)
  })

  it.concurrent('extracts invoice.payment_action_required without a subscription state change', () => {
    const { data } = extractDataEvent(mockContext, { type: 'invoice.payment_action_required', data: { object: makeDunningInvoice() } } as any)
    expect(data.customer_id).toBe('cus_test_dunning')
    expect(data.status).toBe('updated')
    expect(data.price_id).toBeUndefined()
    expect(data.product_id).toBeUndefined()
  })

  it.concurrent('only treats customer.* profile events as customer profile events', () => {
    expect(stripeEventTestUtils.isCustomerProfileEvent(makeCustomerEvent('customer.updated'))).toBe(true)
    expect(stripeEventTestUtils.isCustomerProfileEvent({ type: 'customer.subscription.updated' } as any)).toBe(false)
  })
})

describe('stripe billing Bento tag updates', () => {
  const emails = ['Owner@Example.com ', 'owner@example.com', 'billing@stripe.example', null, '', ' Billing@Stripe.Example ', 'creator@example.com']
  const unique = ['owner@example.com', 'billing@stripe.example', 'creator@example.com']

  it.concurrent('normalizes and deduplicates every billing-linked email in first-seen order', () => {
    const segment = { segments: ['capgo', 'paying', 'plan:Solo'], deleteSegments: ['trial', 'trial0', 'canceled'] }
    expect(stripeEventTestUtils.uniqueBillingEmails(emails)).toEqual(unique)
    expect(stripeEventTestUtils.buildBillingBentoTagUpdates(emails, segment)).toEqual(unique.map(email => ({ email, ...segment })))
  })

  it.concurrent('sends dunning events to every org member and tags only billing admins', () => {
    expect(stripeEventTestUtils.BENTO_DUNNING_EVENT_AUDIENCE).toBe('all')
    expect(stripeEventTestUtils.BENTO_TAG_AUDIENCE).toBe('billing')
    expect(orgEmailNotificationTestUtils.AUDIENCE_ROLE_NAMES.all).toEqual([])
    expect(orgEmailNotificationTestUtils.AUDIENCE_ROLE_NAMES.billing).toEqual(['org_super_admin', 'org_billing_admin'])
  })
})

describe('stripe customer country sync', () => {
  it.concurrent.each([
    ['it', 'IT'],
    [' us ', 'US'],
    ['', null],
    ['   ', null],
    ['gbr', null],
    ['1@', null],
    [null, null],
    [undefined, null],
  ])('normalizes country code %j to %j', (input, expected) => {
    expect(normalizeStripeCountryCode(input)).toBe(expected)
  })
})

describe('stripe customer billing email sync', () => {
  it.concurrent('normalizes billing emails the same way extraction does', () => {
    expect(normalizeBillingEmail(' Billing@Stripe.Example ')).toBe('billing@stripe.example')
    expect(normalizeBillingEmail('   ')).toBeNull()
    expect(normalizeBillingEmail(null)).toBeNull()
  })

  it.concurrent('extracts a normalized customer email from customer.created and customer.updated', () => {
    const updated = makeCustomerEvent('customer.updated', { email: ' Billing@Stripe.Example ' })
    expect(getStripeCustomerEmailFromEvent(updated)).toBe('billing@stripe.example')
    expect(extractDataEvent(mockContext, updated).data.customer_id).toBe('cus_billing_email')
    expect(getStripeCustomerEmailFromEvent(makeCustomerEvent('customer.created', { email: 'INVOICES@org.example' }))).toBe('invoices@org.example')
  })

  it.concurrent('ignores missing, blank, deleted, or non-customer emails', () => {
    expect(getStripeCustomerEmailFromEvent(makeCustomerEvent('customer.updated', { email: null }))).toBeNull()
    expect(getStripeCustomerEmailFromEvent(makeCustomerEvent('customer.updated', { email: '   ' }))).toBeNull()
    expect(getStripeCustomerEmailFromEvent({ data: { object: { deleted: true, id: 'cus_deleted', object: 'customer' } }, type: 'customer.updated' } as any)).toBeNull()
    expect(getStripeCustomerEmailFromEvent({
      data: { object: { customer: 'cus_billing_email', email: 'ignored@example.com', id: 'sub_123', object: 'subscription' } },
      type: 'customer.subscription.updated',
    } as any)).toBeNull()
  })

  it.concurrent('replaces the org management email only when Stripe has a different address', () => {
    expect(stripeEventTestUtils.shouldReplaceOrgManagementEmail('old@example.com', 'invoices@example.com')).toBe(true)
    expect(stripeEventTestUtils.shouldReplaceOrgManagementEmail('Invoices@Example.com ', 'invoices@example.com')).toBe(false)
    expect(stripeEventTestUtils.shouldReplaceOrgManagementEmail('old@example.com', null)).toBe(false)
    expect(stripeEventTestUtils.shouldReplaceOrgManagementEmail(null, 'invoices@example.com')).toBe(true)
  })

  it.concurrent('treats customer.created, or customer.updated with a previous email, as an email change', () => {
    const withPrevious = (previous_attributes: Record<string, unknown>) => ({
      ...makeCustomerEvent('customer.updated'),
      data: { object: { email: 'invoices@example.com', id: 'cus_billing_email', object: 'customer' }, previous_attributes },
    })
    expect(stripeEventTestUtils.didStripeCustomerEmailChange(makeCustomerEvent('customer.updated', { email: 'invoices@example.com' }))).toBe(false)
    expect(stripeEventTestUtils.didStripeCustomerEmailChange(withPrevious({ email: 'old@example.com' }))).toBe(true)
    expect(stripeEventTestUtils.didStripeCustomerEmailChange(withPrevious({ name: 'New name' }))).toBe(false)
    expect(stripeEventTestUtils.didStripeCustomerEmailChange(makeCustomerEvent('customer.created', { email: 'invoices@example.com' }))).toBe(true)
  })
})

describe('dunning invoice helpers', () => {
  it.concurrent('detects subscription invoices from parent or billing reason', () => {
    expect(isSubscriptionInvoice(makeDunningInvoice())).toBe(true)
    expect(isSubscriptionInvoice(makeDunningInvoice({ parent: null, billing_reason: 'subscription_create' }))).toBe(true)
    expect(isSubscriptionInvoice(makeDunningInvoice({ parent: null, billing_reason: 'manual' }))).toBe(false)
  })

  it.concurrent.each([
    [1400, 'usd', 14],
    [1400, 'JPY', 1400],
    [14000, 'kwd', 14],
    [500, 'ugx', 5],
    [500, 'isk', 5],
  ])('converts %i %s minor units to %i', (amount, currency, expected) => {
    expect(stripeAmountToMajorUnits(amount, currency)).toBe(expected)
  })

  it.concurrent('maps only the public pay-link fields', () => {
    expect(toOpenSubscriptionInvoiceSummary(makeDunningInvoice({ amount_remaining: 900 }))).toEqual({
      hosted_invoice_url: 'https://invoice.stripe.com/i/test_dunning',
      amount_due: 900,
      currency: 'usd',
      attempt_count: 2,
      next_payment_attempt: new Date(1_760_259_200 * 1000).toISOString(),
    })
    expect(toOpenSubscriptionInvoiceSummary(makeDunningInvoice({ next_payment_attempt: null, hosted_invoice_url: undefined })).next_payment_attempt).toBeNull()
  })

  it.concurrent('adds retry info but never the Stripe hosted invoice link to the failed payment event, or nothing without an invoice', () => {
    const summary = toOpenSubscriptionInvoiceSummary(makeDunningInvoice())
    expect(stripeEventTestUtils.buildDunningInvoiceBentoData(summary)).toEqual({
      attempt_count: 2,
      next_payment_attempt: summary.next_payment_attempt,
      amount: 14,
      currency: 'usd',
    })
    expect(stripeEventTestUtils.buildDunningInvoiceBentoData(null)).toEqual({})
  })

  it('links billing emails to the console billing page of the org', () => {
    try {
      vi.stubEnv('WEBAPP_URL', 'https://console.capgo.app/')
      expect(stripeEventTestUtils.getConsoleBillingUrl(mockContext, 'org-1')).toBe('https://console.capgo.app/settings/organization/billing?oid=org-1')
      vi.stubEnv('WEBAPP_URL', '')
      expect(stripeEventTestUtils.getConsoleBillingUrl(mockContext, 'org-1')).toBeNull()
    }
    finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('stripe paid_at tracking', () => {
  const at = '2026-03-24T12:00:00.000Z'
  it.concurrent.each([
    ['does not set paid_at before the first payment is confirmed', { paid_at: null, status: null }, 'created', undefined],
    ['sets paid_at when an org first becomes paying', { paid_at: null, status: null }, 'succeeded', at],
    ['does not overwrite an existing paid_at', { paid_at: '2026-03-20T09:00:00.000Z', status: 'succeeded' }, 'succeeded', undefined],
    ['does not backfill legacy succeeded rows', { paid_at: null, status: 'succeeded' }, 'succeeded', undefined],
    ['ignores non-succeeded status changes', { paid_at: null, status: null }, 'updated', undefined],
  ] as const)('%s', (_label, current, status, expected) => {
    expect(stripeEventTestUtils.getPaidAtUpdate(current as any, status, at)).toBe(expected)
  })
})

describe('enterprise extra MAU item', () => {
  const OPEN = 9223372036854775807
  const mauSteps = [
    { step_min: 0, step_max: 1_000_000, price_per_unit: 0.003 },
    { step_min: 1_000_000, step_max: 3_000_000, price_per_unit: 0.0006 },
    { step_min: 3_000_000, step_max: 6_000_000, price_per_unit: 0.00045 },
    { step_min: 6_000_000, step_max: OPEN, price_per_unit: 0.00035 },
  ]
  const extraMauPrice = { id: 'price_extra_mau_month', lookup_key: 'capgo_extra_mau_month_abc', metadata: { capgo_kind: 'extra_mau' }, recurring: { interval: 'month' } }
  const planPrice = { lookup_key: null, metadata: {}, recurring: { interval: 'month' } }
  const item = (priceId: string, productId: string, price: any, quantity = 1) => ({
    current_period_end: 1_714_517_200,
    current_period_start: 1_711_925_200,
    quantity,
    price,
    plan: { id: priceId, interval: 'month', product: productId, usage_type: 'licensed' },
  })
  const extraItem = item('price_extra_mau_month', 'prod_extra_mau', extraMauPrice, 2000)
  const planItem = item('price_enterprise_month', 'prod_enterprise', planPrice)
  const subscriptionEvent = (type: string, status: string, items: unknown[]) => extractDataEvent(mockContext, {
    type,
    data: { object: { id: 'sub_enterprise_3m', customer: 'cus_enterprise_3m', status, items: { data: items } }, previous_attributes: {} },
  } as any).data

  it.concurrent('detects tagged extra MAU prices by metadata or lookup key', () => {
    expect(isExtraMauPrice({ metadata: { capgo_kind: 'extra_mau' } })).toBe(true)
    expect(isExtraMauPrice({ lookup_key: 'capgo_extra_mau_year_x' })).toBe(true)
    expect(isExtraMauPrice({ lookup_key: 'enterprise_month', metadata: {} })).toBe(false)
    expect(isExtraMauPrice(undefined)).toBe(false)
  })

  it.concurrent('counts extra MAU in units of 1,000', () => {
    expect(getExtraMau([{ price: extraMauPrice, quantity: 2000 }, { price: { lookup_key: null, metadata: {} }, quantity: 1 }] as any)).toBe(2_000_000)
  })

  it.concurrent('builds graduated per-1k tiers above the plan allowance', () => {
    expect(buildExtraMauTiers(mauSteps, 1_000_000, 'month')).toEqual([
      { up_to: 2000, unit_amount: 60 },
      { up_to: 5000, unit_amount: 45 },
      { up_to: 'inf', unit_amount: 35 },
    ])
    expect(buildExtraMauTiers(mauSteps, 1_000_000, 'year')[0]).toEqual({ up_to: 2000, unit_amount: 720 })
  })

  it.concurrent('keeps the plan item as the plan and syncs extra MAU when the extra item comes first', () => {
    const data = subscriptionEvent('customer.subscription.updated', 'active', [extraItem, planItem])
    expect(data.price_id).toBe('price_enterprise_month')
    expect(data.product_id).toBe('prod_enterprise')
    expect(data.extra_mau).toBe(2_000_000)
  })

  it.concurrent('drops the extra MAU when the subscription is deleted', () => {
    expect(subscriptionEvent('customer.subscription.deleted', 'canceled', [planItem, extraItem]).extra_mau).toBe(0)
  })
})

describe('transfer invoice footer helpers', () => {
  it.concurrent.each([
    ['send_invoice', ['card'], true],
    ['charge_automatically', ['us_bank_account'], true],
    ['charge_automatically', ['card'], false],
    ...['ach_debit', 'sepa_debit', 'acss_debit', 'bacs_debit', 'au_becs_debit'].map(type => ['charge_automatically', [type], false] as const),
  ] as const)('classifies %s with %j as transfer=%s', (collectionMethod, paymentMethodTypes, expected) => {
    expect(stripeEventTestUtils.isTransferInvoice(makeTransferInvoice({ collectionMethod, paymentMethodTypes: [...paymentMethodTypes] }))).toBe(expected)
  })

  it.concurrent.each([
    ['stamps draft transfer invoices without the OUR marker', { status: 'draft', footer: null }, true],
    ['skips finalized transfer invoices', { status: 'open' }, false],
    ['skips draft card-only invoices', { collectionMethod: 'charge_automatically', paymentMethodTypes: ['card'], status: 'draft' }, false],
    ['skips invoices that already contain the OUR marker', { footer: TRANSFER_FOOTER, status: 'draft' }, false],
  ] as const)('%s', (_label, invoice, expected) => {
    expect(stripeEventTestUtils.shouldStampTransferInvoiceFooter(makeTransferInvoice(invoice as any))).toBe(expected)
  })

  it.concurrent('appends the transfer footer to an existing footer within the Stripe length limit', () => {
    const existingFooter = 'Include PO #12345 on the wire memo. Contact billing@example.com for tax forms.'
    expect(stripeEventTestUtils.TRANSFER_INVOICE_FOOTER).toBe(TRANSFER_FOOTER)
    expect(stripeEventTestUtils.buildTransferInvoiceFooter(existingFooter)).toBe(`${existingFooter}\n\n${TRANSFER_FOOTER}`)
    const tooLong = 'x'.repeat(stripeEventTestUtils.TRANSFER_INVOICE_FOOTER_MAX_LENGTH)
    expect(stripeEventTestUtils.buildTransferInvoiceFooter(tooLong)).toBeNull()
    expect(stripeEventTestUtils.shouldStampTransferInvoiceFooter(makeTransferInvoice({ footer: tooLong, status: 'draft' }))).toBe(false)
  })

  it.concurrent('builds the update from the live invoice instead of a stale webhook snapshot', () => {
    expect(stripeEventTestUtils.getTransferInvoiceFooterUpdate(makeTransferInvoice({ footer: null, status: 'draft' }))).toBe(TRANSFER_FOOTER)
    expect(stripeEventTestUtils.getTransferInvoiceFooterUpdate(makeTransferInvoice({ footer: 'Include PO #12345 on the wire memo.', status: 'draft' })))
      .toBe(`Include PO #12345 on the wire memo.\n\n${TRANSFER_FOOTER}`)
    // A delayed invoice.created arrives after finalization: the stale snapshot says draft, the live one is open.
    expect(stripeEventTestUtils.shouldStampTransferInvoiceFooter(makeTransferInvoice({ status: 'draft' }))).toBe(true)
    expect(stripeEventTestUtils.getTransferInvoiceFooterUpdate(makeTransferInvoice({ status: 'open' }))).toBeNull()
  })
})

describe('first payment detection for the OpenAI Ads paid conversion', () => {
  const { resolveFirstPaidAt, getPaidAtUpdate } = stripeEventTestUtils
  it.concurrent('fires only when paid_at moves from null to set', () => {
    const paidAt = '2026-10-19T11:30:00.000Z'
    expect(resolveFirstPaidAt(null, paidAt)).toBe(paidAt)
    expect(resolveFirstPaidAt(undefined, paidAt)).toBe(paidAt)
    // A concurrent webhook or an earlier attempt already recorded the first payment.
    expect(resolveFirstPaidAt('2026-10-19T11:29:00.000Z', paidAt)).toBeNull()
    expect(resolveFirstPaidAt(new Date('2026-10-19T11:29:00.000Z'), paidAt)).toBeNull()
    // Renewals and other updates do not write paid_at.
    expect(resolveFirstPaidAt(null, undefined)).toBeNull()
    expect(resolveFirstPaidAt(null, null)).toBeNull()
  })

  it.concurrent('a Stripe retry of the first payment does not write paid_at again', () => {
    const at = '2026-10-19T11:30:00.000Z'
    const firstWrite = getPaidAtUpdate({ paid_at: null, status: 'created' }, 'succeeded', at)
    expect(firstWrite).toBe(at)
    expect(resolveFirstPaidAt(null, firstWrite)).toBe(at)
    const retryWrite = getPaidAtUpdate({ paid_at: at, status: 'succeeded' }, 'succeeded', at)
    expect(retryWrite).toBeUndefined()
    expect(resolveFirstPaidAt(at, retryWrite)).toBeNull()
  })
})
