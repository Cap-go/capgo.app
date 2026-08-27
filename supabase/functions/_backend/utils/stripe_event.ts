import type { Context } from 'hono'
import type { StripeData } from './stripe.ts'
import Stripe from 'stripe'
import { cloudlog, cloudlogErr } from './logging.ts'
import { getStripe, parsePriceIds } from './stripe.ts'
import { type BillingAccount, DEFAULT_BILLING_ACCOUNT, getStripeWebhookSecret } from './stripe_billing_account.ts'

export function parseStripeEvent(
  c: Context,
  body: string,
  signature: string,
  billingAccount: BillingAccount = DEFAULT_BILLING_ACCOUNT,
) {
  const webhookKey = getStripeWebhookSecret(c, billingAccount)

  return getStripe(c, billingAccount).webhooks.constructEventAsync(
    body,
    signature,
    webhookKey,
    undefined,
    Stripe.createSubtleCryptoProvider(),
  )
}

function getLicensedSubscriptionItem(items: Stripe.SubscriptionItem[] | undefined) {
  return items?.find(item => item.plan.usage_type === 'licensed') ?? items?.[0]
}

function getSubscriptionInterval(item: Stripe.SubscriptionItem | undefined) {
  const interval = item?.plan?.interval
  if (interval === 'month' || interval === 'year')
    return interval
  return undefined
}

function getSubscriptionEndDate(subscription: Stripe.Subscription, item: Stripe.SubscriptionItem | null) {
  const itemPeriodEnd = typeof item?.current_period_end === 'number' ? item.current_period_end : null
  const endSeconds = subscription.ended_at
    ?? subscription.cancel_at
    ?? (subscription.cancel_at_period_end ? itemPeriodEnd : null)

  return endSeconds ? new Date(endSeconds * 1000).toISOString() : null
}

function subscriptionUpdated(c: Context, event: Stripe.CustomerSubscriptionCreatedEvent | Stripe.CustomerSubscriptionDeletedEvent | Stripe.CustomerSubscriptionUpdatedEvent, data: StripeData['data']) {
  let isUpgrade = false
  const subscription = event.data.object
  const previousAttributes = event.data.previous_attributes as Partial<Stripe.Subscription>

  // Get previous items if available
  const previousItems = previousAttributes?.items?.data as Stripe.SubscriptionItem[] | undefined
  const previousLicensedItem = getLicensedSubscriptionItem(previousItems)
  const previousPriceId = previousLicensedItem?.plan.id
  const previousProductId = previousLicensedItem?.plan.product as string | undefined
  const previousInterval = getSubscriptionInterval(previousLicensedItem)
  const currentLicensedItem = getLicensedSubscriptionItem(subscription.items.data)
  const currentInterval = getSubscriptionInterval(currentLicensedItem)

  const res = parsePriceIds(c, subscription.items.data)
  data.price_id = res.priceId
  if (res.productId)
    data.product_id = res.productId
  // current_period_start is epoch and current_period_end is epoch
  // subscription_anchor_start is date and subscription_anchor_end is date
  // convert epoch to date
  const currentCycleItem = currentLicensedItem ?? null
  data.subscription_anchor_start = currentCycleItem?.current_period_start
    ? new Date(currentCycleItem.current_period_start * 1000).toISOString()
    : undefined
  data.subscription_anchor_end = currentCycleItem?.current_period_end
    ? new Date(currentCycleItem.current_period_end * 1000).toISOString()
    : undefined
  data.canceled_at = getSubscriptionEndDate(subscription, currentCycleItem)
  if (typeof subscription.trial_end === 'number')
    data.trial_at = new Date(subscription.trial_end * 1000).toISOString()
  data.price_id = currentLicensedItem?.plan.id
  data.product_id = currentLicensedItem?.plan.product
    ? String(currentLicensedItem.plan.product)
    : undefined as any
  if (event.type === 'customer.subscription.deleted') {
    data.status = 'deleted'
  }
  else if (subscription.status === 'past_due') {
    data.status = 'past_due'
  }
  else if (event.type === 'customer.subscription.created') {
    data.status = 'created'
  }
  else {
    // For non-past-due updates, keep the existing normalized status contract.
    data.status = 'updated'
  }
  data.subscription_id = subscription.id
  data.customer_id = String(subscription.customer)

  // Only treat a billing cadence change from monthly to yearly as an upgrade.
  if (previousInterval === 'month' && currentInterval === 'year') {
    isUpgrade = true
  }
  return { data, isUpgrade, previousPriceId, previousProductId }
}

function invoiceUpcoming(event: Stripe.InvoiceUpcomingEvent, data: StripeData['data']) {
  const invoice = event.data.object
  data.status = 'updated'
  data.customer_id = String(invoice.customer)

  const plan = invoice.lines.data[0]
  if (plan) {
    const subscriptionId = plan.parent?.subscription_item_details?.subscription
    if (subscriptionId) {
      data.subscription_id = subscriptionId as string
    }
    const productId = plan.pricing?.price_details?.product
    if (productId) {
      data.product_id = productId as string
    }
    const priceId = plan.pricing?.price_details?.price
    if (priceId) {
      data.price_id = priceId as string
    }
  }
  return data
}

export const TRANSFER_INVOICE_FOOTER = 'For US bank wires: instruct your bank to send OUR (sender pays all correspondent/intermediary fees) so the full invoice amount arrives. Do not use SHA/shared fees.'
export const TRANSFER_INVOICE_FOOTER_MARKER = 'OUR (sender pays all correspondent'
export const TRANSFER_INVOICE_FOOTER_MAX_LENGTH = 5000

const TRANSFER_INVOICE_PAYMENT_METHOD_TYPES = new Set([
  'customer_balance',
  'us_bank_account',
  'ach_credit_transfer',
])

type TransferInvoiceShape = {
  collection_method?: Stripe.Invoice.CollectionMethod | null
  payment_settings?: {
    payment_method_types?: string[] | null
  } | null
}

type TransferInvoiceFooterShape = TransferInvoiceShape & {
  footer?: string | null
  status?: Stripe.Invoice.Status | null
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

function invoiceCreatedOrUpdated(event: Stripe.InvoiceCreatedEvent | Stripe.InvoiceUpdatedEvent, data: StripeData['data']) {
  const invoice = event.data.object
  data.status = 'updated'
  data.customer_id = getStripeCustomerId(invoice.customer)
  return data
}

function getStripeCustomerId(
  customer: Stripe.Charge['customer'] | Stripe.Checkout.Session['customer'] | Stripe.Invoice['customer'],
): string {
  if (!customer)
    return ''
  if (typeof customer === 'string')
    return customer
  if (typeof customer === 'object' && 'id' in customer && typeof customer.id === 'string')
    return customer.id
  return ''
}

export function extractDataEvent(c: Context, event: Stripe.Event): StripeData {
  let data: StripeData['data'] = {
    product_id: undefined as any, // Changed from '' to undefined to avoid FK constraint violations
    price_id: undefined, // Changed from '' to undefined for consistency
    subscription_id: undefined,
    subscription_anchor_start: undefined,
    subscription_anchor_end: undefined,
    customer_id: '',
    is_good_plan: true,
    mau_exceeded: false,
    storage_exceeded: false,
    bandwidth_exceeded: false,
    status: 'succeeded',
  }
  let isUpgrade = false
  let previousPriceId: string | undefined
  let previousProductId: string | undefined

  cloudlog({ requestId: c.get('requestId'), message: 'event', event: JSON.stringify(event, null, 2) })
  if (!event?.data?.object) {
    return { data, isUpgrade, previousPriceId, previousProductId }
  }

  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.created') {
    const res = subscriptionUpdated(c, event, data)
    data = res.data
    isUpgrade = res.isUpgrade
    previousPriceId = res.previousPriceId
    previousProductId = res.previousProductId
  }
  else if (event.type === 'charge.failed') {
    const charge = event.data.object
    data.status = 'failed'
    data.customer_id = getStripeCustomerId(charge.customer)
  }
  else if (event.type === 'charge.succeeded') {
    const charge = event.data.object
    data.status = 'succeeded'
    data.customer_id = getStripeCustomerId(charge.customer)
  }
  else if (event.type === 'invoice.upcoming') {
    data = invoiceUpcoming(event, data)
  }
  else if (event.type === 'invoice.created' || event.type === 'invoice.updated') {
    data = invoiceCreatedOrUpdated(event, data)
  }
  else if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object as Stripe.Checkout.Session
    data.customer_id = getStripeCustomerId(session.customer)
    data.status = 'succeeded'
  }
  else if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object as Stripe.PaymentIntent
    data.customer_id = getStripeCustomerId(paymentIntent.customer)
    data.status = 'succeeded'
  }
  else if (event.type === 'customer.updated' || event.type === 'customer.created') {
    const customer = event.data.object as Stripe.Customer
    data.customer_id = customer.id
    data.status = 'updated'
  }
  else {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Other event', event })
  }
  return { data, isUpgrade, previousPriceId, previousProductId }
}

export function normalizeBillingEmail(email: string | null | undefined) {
  const normalized = email?.trim().toLowerCase()
  return normalized || null
}

export function getStripeCustomerEmailFromEvent(event: Stripe.Event): string | null {
  if (event.type !== 'customer.created' && event.type !== 'customer.updated')
    return null

  const customer = event.data.object
  if (customer?.object !== 'customer')
    return null
  if ('deleted' in customer && customer.deleted)
    return null

  return normalizeBillingEmail(customer.email)
}
