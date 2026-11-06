import type { Context } from 'hono'
import type Stripe from 'stripe'
import type { OpenAIAdsUserRecord } from './openai_ads.ts'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'
import { getOpenAISubscriptionSourceUrl, isOpenAIAdsConfigured, trackOpenAISubscription } from './openai_ads.ts'

type InvoicePayment = Pick<Stripe.Invoice, 'amount_paid' | 'currency' | 'status'>
type InvoiceRef = string | (InvoicePayment & Pick<Stripe.Invoice, 'id'>)

export interface OpenAIFirstPaymentInput {
  orgId: string
  /** The org owner (orgs.created_by): the user the registration event reported. */
  ownerUserId: string
  /** When the first payment happened (see getOpenAIFirstPaymentAt). */
  paidAt: string
  /** Plan name, or the Stripe price id when the plan is unknown. */
  planId: string | null | undefined
  /** The subscription webhook that recorded the first payment. */
  stripeEvent: Stripe.Event | null | undefined
}

export interface OpenAIFirstPaymentDeps {
  loadUser: (userId: string) => Promise<OpenAIAdsUserRecord | null>
  retrieveInvoice: (invoiceId: string) => Promise<InvoicePayment>
  retryDelaysMs?: number[]
  invoiceRetryDelaysMs?: number[]
  budgetMs?: number
}

// Short waits keep the lookup plus the send inside the background-task budget.
const DEFAULT_INVOICE_RETRY_DELAYS_MS = [500, 1_500]
// One budget for the invoice lookup and the send (Workers keep ~30 s after the response).
const FIRST_PAYMENT_BUDGET_MS = 25_000
// How old paid_at may be when a later webhook recovers the conversion. The
// event is timestamped with the payment, so the API's 7-day limit does not
// apply to paid_at; the window only keeps orgs that paid long ago (and start a
// new subscription) from being reported. An incomplete subscription is paid or
// expires within a day; an invoiced one has payment terms, and a Stripe trial
// lasts weeks.
const INCOMPLETE_RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const LONG_RECOVERY_WINDOW_MS = 60 * 24 * 60 * 60 * 1000
// The owner lookup runs beside the invoice lookup, inside the shared budget.
const USER_LOOKUP_TIMEOUT_MS = 5_000

/**
 * Payment proof from the subscription's latest invoice. Only a `paid` invoice
 * counts: paid_at is also set for a subscription created `incomplete` (for
 * example while 3-D Secure is pending), which is not a payment yet. A paid $0
 * invoice (promotion code covering the first period) is a real enrollment and
 * is reported with amount 0: it is the org's only first-payment moment, since
 * paid_at is already set when the discount ends.
 */
export function getInvoicePayment(invoice: InvoicePayment | null | undefined): { amount: number, currency: string } | null {
  if (!invoice || invoice.status !== 'paid' || typeof invoice.amount_paid !== 'number' || invoice.amount_paid < 0 || !invoice.currency)
    return null
  return { amount: invoice.amount_paid, currency: invoice.currency.toUpperCase() }
}

/**
 * The subscription that set paid_at before any payment became active, so its
 * first real invoice was just paid: `incomplete` (payment pending) or
 * `trialing` (Stripe-managed trial) to `active`.
 */
export function getSubscriptionActivationSource(stripeEvent: Stripe.Event | null | undefined): 'incomplete' | 'trialing' | null {
  if (stripeEvent?.type !== 'customer.subscription.updated' || stripeEvent.data.object.status !== 'active')
    return null
  const previousStatus = (stripeEvent.data.previous_attributes as Partial<Stripe.Subscription> | undefined)?.status
  return previousStatus === 'incomplete' || previousStatus === 'trialing' ? previousStatus : null
}

export function isIncompleteSubscriptionActivation(stripeEvent: Stripe.Event | null | undefined): boolean {
  return getSubscriptionActivationSource(stripeEvent) === 'incomplete'
}

/**
 * The first invoice of an invoiced (`send_invoice`, e.g. bank transfer)
 * subscription was just paid. Stripe activates those subscriptions before
 * payment, so paid_at was set while the invoice was still open.
 */
export function isFirstSubscriptionInvoicePaid(stripeEvent: Stripe.Event | null | undefined): boolean {
  // invoice.updated is the invoice event this webhook already routes (customer
  // id extraction included); paying an invoice changes its status, so it fires.
  if (stripeEvent?.type !== 'invoice.updated')
    return false
  const invoice = stripeEvent.data.object
  if (invoice.status !== 'paid' || invoice.billing_reason !== 'subscription_create' || invoice.collection_method !== 'send_invoice')
    return false
  const previousStatus = (stripeEvent.data.previous_attributes as Partial<Stripe.Invoice> | undefined)?.status
  return !!previousStatus && previousStatus !== 'paid'
}

/**
 * When to report the first payment, or null when this webhook must not.
 * - paid_at went from null to set in this webhook: report at that time.
 * - paid_at was set before the first invoice was paid, and it is paid now: an
 *   `incomplete` or `trialing` subscription became active, or an invoiced
 *   subscription's first invoice was paid. Only while paid_at is recent (see the windows), so
 *   an org that paid long ago and starts a new subscription is not reported.
 * The event id is per org, so OpenAI drops a second send for the same org.
 */
export function getOpenAIFirstPaymentAt(input: {
  firstPaidAt: string | null
  currentPaidAt: string | null | undefined
  stripeEvent: Stripe.Event | null | undefined
  eventOccurredAtIso: string
  now?: number
}): string | null {
  if (input.firstPaidAt)
    return input.firstPaidAt
  if (!input.currentPaidAt)
    return null
  const activation = getSubscriptionActivationSource(input.stripeEvent)
  const windowMs = activation === 'incomplete'
    ? INCOMPLETE_RECOVERY_WINDOW_MS
    : activation === 'trialing' || isFirstSubscriptionInvoicePaid(input.stripeEvent) ? LONG_RECOVERY_WINDOW_MS : 0
  const paidAt = Date.parse(input.currentPaidAt)
  if (!windowMs || !Number.isFinite(paidAt) || (input.now ?? Date.now()) - paidAt > windowMs)
    return null
  return input.eventOccurredAtIso
}

function getLatestInvoiceRef(stripeEvent: Stripe.Event | null | undefined): InvoiceRef | null {
  // invoice.paid grants paid access to a subscription that waited for its payment (ACH).
  if (stripeEvent?.type === 'invoice.updated' || stripeEvent?.type === 'invoice.paid' || stripeEvent?.type === 'invoice.payment_succeeded')
    return stripeEvent.data.object.id ?? null
  if (!stripeEvent?.type.startsWith('customer.subscription.'))
    return null
  const subscription = stripeEvent.data.object as Stripe.Subscription
  // A Stripe trial's $0 invoice is not a payment.
  if (subscription.status === 'trialing')
    return null
  return subscription.latest_invoice ?? null
}

async function loadInvoicePayment(c: Context, stripeEvent: Stripe.Event | null | undefined, deps: OpenAIFirstPaymentDeps, deadlineMs: number) {
  const ref = getLatestInvoiceRef(stripeEvent)
  if (!ref)
    return null
  const invoiceId = typeof ref === 'string' ? ref : ref.id
  const retryDelaysMs = deps.invoiceRetryDelaysMs ?? DEFAULT_INVOICE_RETRY_DELAYS_MS
  // paid_at is already committed, so this is the only chance to report the
  // conversion: retry a transient Stripe failure a bounded number of times.
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    try {
      // Always read the live invoice: the event copy can predate the payment.
      return getInvoicePayment(await deps.retrieveInvoice(invoiceId))
    }
    catch (error) {
      // Leave the rest of the shared budget to the send.
      if (attempt === retryDelaysMs.length || Date.now() + retryDelaysMs[attempt] > deadlineMs - 10_000) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'OpenAI Ads subscription: invoice lookup failed', invoiceId, attempt: attempt + 1, error: serializeError(error) })
        return null
      }
      await new Promise(resolve => setTimeout(resolve, retryDelaysMs[attempt]))
    }
  }
  return null
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Report an org's first payment to OpenAI Ads as `subscription_created`.
 * Call when getOpenAIFirstPaymentAt returns a time, from backgroundTask. Sends
 * only with proof of payment (a paid latest invoice). Never throws, so it cannot fail the webhook.
 */
export async function trackOpenAIFirstPayment(c: Context, input: OpenAIFirstPaymentInput, deps: OpenAIFirstPaymentDeps): Promise<boolean> {
  try {
    if (!isOpenAIAdsConfigured(c))
      return false
    const deadlineMs = Date.now() + (deps.budgetMs ?? FIRST_PAYMENT_BUDGET_MS)
    const [user, payment] = await Promise.all([
      withTimeout(deps.loadUser(input.ownerUserId), USER_LOOKUP_TIMEOUT_MS, 'owner lookup timed out'),
      loadInvoicePayment(c, input.stripeEvent, deps, deadlineMs),
    ])
    if (!payment) {
      // No proof of payment (unpaid, missing or unreadable invoice): never report a conversion that did not happen.
      cloudlog({ requestId: c.get('requestId'), message: 'OpenAI Ads subscription skipped: latest invoice not paid', orgId: input.orgId })
      return false
    }
    if (!user) {
      cloudlog({ requestId: c.get('requestId'), message: 'OpenAI Ads subscription skipped: owner not found', orgId: input.orgId, userId: input.ownerUserId })
      return false
    }
    return await trackOpenAISubscription(c, {
      orgId: input.orgId,
      user,
      paidAt: input.paidAt,
      planId: input.planId,
      ...payment,
      sourceUrl: getOpenAISubscriptionSourceUrl(c),
    }, { retryDelaysMs: deps.retryDelaysMs, deadlineMs })
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'OpenAI Ads subscription event error', orgId: input.orgId, error: serializeError(error) })
    return false
  }
}
