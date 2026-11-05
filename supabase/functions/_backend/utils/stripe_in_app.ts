import type { Context } from 'hono'
import type Stripe from 'stripe'
import type { BillingAccount } from './stripe_billing.ts'
import { simpleError } from './hono.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { findLatestOpenSubscriptionInvoice, getActiveSubscriptionId, getStripe, lookupActiveSubscriptionId, syncSubscriptionData } from './stripe.ts'
import { getBillingAccountForCustomer, getStripePublishableKey, isStripeConfiguredForAccount } from './stripe_billing.ts'
import { releaseTrialPlanSchedule } from './stripe_trial_plan.ts'

// In-app replacements for the Stripe billing portal and hosted invoice page.

export const CANCEL_FEEDBACK_VALUES = [
  'customer_service',
  'low_quality',
  'missing_features',
  'other',
  'switched_service',
  'too_complex',
  'too_expensive',
  'unused',
] as const satisfies readonly Stripe.SubscriptionUpdateParams.CancellationDetails.Feedback[]

export type CancelFeedback = typeof CANCEL_FEEDBACK_VALUES[number]

export const MAX_CANCEL_COMMENT_LENGTH = 1000

export interface InAppBillingContext {
  customerId: string
  billingAccount: BillingAccount
  stripe: Stripe
  // Empty when Stripe.js is not configured: server-only actions still work.
  publishableKey: string
}

export interface CardSummary {
  id: string
  brand: string
  last4: string
  expMonth: number
  expYear: number
}

export interface SubscriptionSummary {
  status: Stripe.Subscription.Status
  cancelAtPeriodEnd: boolean
  cancelAt: string | null
  currentPeriodEnd: string | null
}

export interface InvoiceListItem {
  id: string
  number: string | null
  created: string
  total: number
  amountDue: number
  currency: string
  status: Stripe.Invoice.Status | null
  pdfUrl: string | null
}

export interface OpenInvoiceSummary {
  id: string
  amountDue: number
  currency: string
}

export type PayInvoiceResult
  = | { status: 'paid' }
    | { status: 'requires_action', clientSecret: string, publishableKey: string }
    | { status: 'requires_payment_method', message: string }

function toIso(seconds: number | null | undefined) {
  return seconds ? new Date(seconds * 1000).toISOString() : null
}

export async function getInAppBillingContext(c: Context, customerId: string): Promise<InAppBillingContext> {
  const billingAccount = await getBillingAccountForCustomer(c, customerId)
  if (!isStripeConfiguredForAccount(c, billingAccount))
    throw simpleError('billing_account_unavailable', 'Billing is temporarily unavailable for this organization', { billingAccount })
  return { customerId, billingAccount, stripe: getStripe(c, billingAccount), publishableKey: getStripePublishableKey(c, billingAccount) }
}

// Card forms and 3DS run in Stripe.js, which needs the account's publishable key.
function requirePublishableKey(ctx: InAppBillingContext) {
  if (!ctx.publishableKey)
    throw simpleError('stripe_publishable_key_missing', 'Card entry is not configured for this organization', { billingAccount: ctx.billingAccount })
  return ctx.publishableKey
}

function toCardSummary(paymentMethod: Stripe.PaymentMethod | null | undefined): CardSummary | null {
  if (!paymentMethod?.card)
    return null
  return {
    id: paymentMethod.id,
    brand: paymentMethod.card.brand,
    last4: paymentMethod.card.last4,
    expMonth: paymentMethod.card.exp_month,
    expYear: paymentMethod.card.exp_year,
  }
}

export interface SavedCards {
  card: CardSummary | null
  backupCard: CardSummary | null
}

export type PaymentMethodRole = 'default' | 'backup'

function isExpired(paymentMethod: Stripe.PaymentMethod, now = new Date()) {
  const card = paymentMethod.card
  if (!card)
    return true
  const year = now.getUTCFullYear()
  return card.exp_year < year || (card.exp_year === year && card.exp_month < now.getUTCMonth() + 1)
}

// known is false when the lookup failed: the subscription card is then unknown, not absent.
async function getSubscriptionDefaultPaymentMethod(c: Context, stripe: Stripe, customerId: string) {
  try {
    // getActiveSubscriptionId collapses DB errors to null; use the typed lookup for detach safety.
    const { subscriptionId, known } = await lookupActiveSubscriptionId(c, customerId)
    if (!known)
      return { paymentMethod: null, known: false }
    if (!subscriptionId)
      return { paymentMethod: null, known: true }
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['default_payment_method'] })
    const paymentMethod = subscription.default_payment_method
    return { paymentMethod: paymentMethod && typeof paymentMethod === 'object' ? paymentMethod : null, known: true }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'getSubscriptionDefaultPaymentMethod', customerId, error })
    return { paymentMethod: null, known: false }
  }
}

// Primary: the card Stripe charges (subscription card, then customer default). The backup is the
// newest other valid card: Stripe only ever charges the primary on its own.
// newCardId is a card being saved right now: it must never be guessed as the primary.
async function findSavedPaymentMethods(c: Context, stripe: Stripe, customerId: string, newCardId?: string) {
  const customer = await stripe.customers.retrieve(customerId, { expand: ['invoice_settings.default_payment_method'] })
  if (customer.deleted) {
    return {
      defaultPaymentMethod: null,
      backupPaymentMethod: null,
      isCustomerDefault: false,
      spareCards: [],
      customerDefaultId: null,
      subscriptionKnown: true,
    }
  }
  const [cards, subscriptionLookup] = await Promise.all([
    // Stripe's page maximum; customers never get near it, so older eligible cards are not missed.
    stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 100 }),
    getSubscriptionDefaultPaymentMethod(c, stripe, customerId),
  ])
  const subscriptionDefault = subscriptionLookup.paymentMethod
  const customerDefault = customer.invoice_settings?.default_payment_method
  const isCustomerDefault = !!customerDefault && typeof customerDefault === 'object'
  // Very old customers only have the card Checkout saved, without any default.
  const defaultPaymentMethod = subscriptionDefault
    ?? (isCustomerDefault ? customerDefault : null)
    ?? cards.data.find(paymentMethod => paymentMethod.id !== newCardId)
    ?? null
  const defaultFingerprint = defaultPaymentMethod?.card?.fingerprint
  // Cards Stripe may charge on its own (subscription card, customer default) are never spare
  // and never the removable backup: detaching the customer default would break credit auto top-up.
  const inUse = new Set([subscriptionDefault?.id, isCustomerDefault ? customerDefault.id : undefined, defaultPaymentMethod?.id])
  // Without a known subscription default, another saved card might be the live subscription card.
  const backupPaymentMethod = subscriptionLookup.known
    ? cards.data.find(paymentMethod => !inUse.has(paymentMethod.id)
      && !isExpired(paymentMethod)
      && (!defaultFingerprint || paymentMethod.card?.fingerprint !== defaultFingerprint)) ?? null
    : null
  // Without the subscription card we cannot tell which cards are spare: detach nothing.
  const spareCards = subscriptionLookup.known ? cards.data.filter(paymentMethod => !inUse.has(paymentMethod.id)) : []
  return {
    defaultPaymentMethod,
    backupPaymentMethod,
    isCustomerDefault,
    spareCards,
    customerDefaultId: isCustomerDefault ? customerDefault.id : null,
    subscriptionKnown: subscriptionLookup.known,
  }
}

// Only one backup at a time: an older spare card must never come back as the backup.
async function detachSpareCards(c: Context, ctx: InAppBillingContext, spareCards: Stripe.PaymentMethod[], keepId?: string) {
  await Promise.all(spareCards.filter(paymentMethod => paymentMethod.id !== keepId).map(async (paymentMethod) => {
    try {
      await ctx.stripe.paymentMethods.detach(paymentMethod.id)
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'detachSpareCards', customerId: ctx.customerId, paymentMethodId: paymentMethod.id, error })
    }
  }))
}

export async function getSavedCards(c: Context, ctx: InAppBillingContext): Promise<SavedCards> {
  const { defaultPaymentMethod, backupPaymentMethod } = await findSavedPaymentMethods(c, ctx.stripe, ctx.customerId)
  return { card: toCardSummary(defaultPaymentMethod), backupCard: toCardSummary(backupPaymentMethod) }
}

export async function getSubscriptionSummary(c: Context, ctx: InAppBillingContext): Promise<SubscriptionSummary | null> {
  const subscriptionId = await getActiveSubscriptionId(c, ctx.customerId)
  if (!subscriptionId)
    return null
  try {
    const subscription = await ctx.stripe.subscriptions.retrieve(subscriptionId)
    const periodEnd = Math.max(0, ...subscription.items.data.map(item => item.current_period_end ?? 0))
    return {
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      cancelAt: toIso(subscription.cancel_at),
      currentPeriodEnd: toIso(periodEnd),
    }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'getSubscriptionSummary', subscriptionId, error })
    return null
  }
}

export async function listInvoices(ctx: InAppBillingContext, limit = 24): Promise<InvoiceListItem[]> {
  const invoices = await ctx.stripe.invoices.list({ customer: ctx.customerId, limit })
  return invoices.data
    .filter(invoice => invoice.status !== 'draft' && !!invoice.id)
    .map(invoice => ({
      id: invoice.id!,
      number: invoice.number ?? null,
      created: toIso(invoice.created)!,
      total: invoice.total,
      amountDue: invoice.amount_remaining ?? invoice.amount_due,
      currency: invoice.currency,
      status: invoice.status ?? null,
      pdfUrl: invoice.invoice_pdf ?? null,
    }))
}

export async function getOpenInvoiceSummary(c: Context, ctx: InAppBillingContext): Promise<OpenInvoiceSummary | null> {
  const invoice = await findLatestOpenSubscriptionInvoice(c, ctx.customerId, ctx.billingAccount)
  if (!invoice?.id)
    return null
  return { id: invoice.id, amountDue: invoice.amount_remaining ?? invoice.amount_due, currency: invoice.currency }
}

export async function createCardSetupIntent(ctx: InAppBillingContext) {
  const publishableKey = requirePublishableKey(ctx)
  const setupIntent = await ctx.stripe.setupIntents.create({
    customer: ctx.customerId,
    // Renewals and credit auto top-up charge the card without the user present.
    usage: 'off_session',
    payment_method_types: ['card'],
  })
  return { clientSecret: setupIntent.client_secret, publishableKey }
}

async function resolveConfirmedPaymentMethodId(ctx: InAppBillingContext, intentId: string) {
  if (/^seti_\w+$/.test(intentId)) {
    const setupIntent = await ctx.stripe.setupIntents.retrieve(intentId)
    if (setupIntent.customer !== ctx.customerId || setupIntent.status !== 'succeeded')
      throw simpleError('invalid_setup_intent', 'Card setup is not complete')
    return typeof setupIntent.payment_method === 'string' ? setupIntent.payment_method : setupIntent.payment_method?.id ?? null
  }
  if (/^pi_\w+$/.test(intentId)) {
    const paymentIntent = await ctx.stripe.paymentIntents.retrieve(intentId)
    if (paymentIntent.customer !== ctx.customerId || paymentIntent.status !== 'succeeded')
      throw simpleError('invalid_payment_intent', 'Payment is not complete')
    return typeof paymentIntent.payment_method === 'string' ? paymentIntent.payment_method : paymentIntent.payment_method?.id ?? null
  }
  throw simpleError('invalid_intent_id', 'Invalid intent id')
}

// default: renewals, retries and auto top-up use it. backup: charged only when the default fails.
export async function savePaymentMethodFromIntent(c: Context, ctx: InAppBillingContext, intentId: string, role: PaymentMethodRole = 'default') {
  const paymentMethodId = await resolveConfirmedPaymentMethodId(ctx, intentId)
  if (!paymentMethodId)
    throw simpleError('missing_payment_method', 'No card was saved')
  const paymentMethod = await ctx.stripe.paymentMethods.retrieve(paymentMethodId)
  // Backup path resolves subscription role first so an unknown lookup never attaches or detaches.
  const backupCards = role === 'backup'
    ? await findSavedPaymentMethods(c, ctx.stripe, ctx.customerId, paymentMethodId)
    : null
  if (backupCards && !backupCards.subscriptionKnown)
    throw simpleError('subscription_lookup_unknown', 'Subscription payment method is temporarily unknown')
  if (paymentMethod.customer !== ctx.customerId)
    await ctx.stripe.paymentMethods.attach(paymentMethodId, { customer: ctx.customerId })
  if (backupCards) {
    const { defaultPaymentMethod, isCustomerDefault, spareCards } = backupCards
    if (defaultPaymentMethod && defaultPaymentMethod.id !== paymentMethodId) {
      const fingerprint = paymentMethod.card?.fingerprint
      if (fingerprint && fingerprint === defaultPaymentMethod.card?.fingerprint) {
        // The same physical card cannot back itself up.
        await ctx.stripe.paymentMethods.detach(paymentMethodId)
        throw simpleError('backup_same_as_primary', 'This card is already your main card')
      }
      // Pin the current primary so the newer backup can never be mistaken for it.
      if (!isCustomerDefault)
        await ctx.stripe.customers.update(ctx.customerId, { invoice_settings: { default_payment_method: defaultPaymentMethod.id } })
      await detachSpareCards(c, ctx, spareCards, paymentMethodId)
      cloudlog({ requestId: c.get('requestId'), message: 'in-app backup card saved', customerId: ctx.customerId, paymentMethodId })
      return toCardSummary(paymentMethod)
    }
    // Nothing to back up: the card becomes the primary.
  }
  await ctx.stripe.customers.update(ctx.customerId, { invoice_settings: { default_payment_method: paymentMethodId } })
  const subscriptionId = await getActiveSubscriptionId(c, ctx.customerId)
  if (subscriptionId) {
    try {
      await ctx.stripe.subscriptions.update(subscriptionId, { default_payment_method: paymentMethodId })
    }
    catch (error) {
      // The customer default still applies; a subscription-level default would only override it.
      cloudlogErr({ requestId: c.get('requestId'), message: 'setDefaultPaymentMethod subscription update', subscriptionId, error })
    }
  }
  return toCardSummary(paymentMethod)
}

export function parsePaymentMethodRole(value: unknown): PaymentMethodRole {
  if (value === undefined || value === null || value === 'default')
    return 'default'
  if (value === 'backup')
    return 'backup'
  throw simpleError('invalid_payment_method_role', 'Role must be default or backup')
}

// Only the backup can be removed: the default keeps renewals working.
export async function removeBackupCard(c: Context, ctx: InAppBillingContext, paymentMethodId: string) {
  const { backupPaymentMethod, spareCards, customerDefaultId, subscriptionKnown } = await findSavedPaymentMethods(c, ctx.stripe, ctx.customerId)
  // Refuse until the subscription default is verified: an unknown lookup can mislabel it as backup.
  if (!subscriptionKnown)
    throw simpleError('subscription_lookup_unknown', 'Subscription payment method is temporarily unknown')
  if (!backupPaymentMethod || backupPaymentMethod.id !== paymentMethodId || paymentMethodId === customerDefaultId)
    throw simpleError('invalid_payment_method', 'This card is not the backup card')
  await ctx.stripe.paymentMethods.detach(paymentMethodId)
  // Older spare cards would otherwise become the next backup and keep fallback charging on.
  await detachSpareCards(c, ctx, spareCards, paymentMethodId)
  cloudlog({ requestId: c.get('requestId'), message: 'in-app backup card removed', customerId: ctx.customerId, paymentMethodId })
  return await getSavedCards(c, ctx)
}

export interface FailedAttempt {
  chargeId?: string | null
  paymentMethodId?: string | null
}

export type BackupChargeResult = 'paid' | 'declined' | 'no_backup' | 'failed_card_is_backup'

function isCardError(error: unknown) {
  return !!error && typeof error === 'object' && 'type' in error && error.type === 'StripeCardError'
}

// Charges an open renewal with the backup card after the default was declined. Card declines are a
// result; any other Stripe error is thrown, since the outcome is unknown and the caller must retry.
// The key is scoped to the failed charge: the webhook and Pay now share one backup charge per attempt,
// and a later failed attempt (a new charge) is still eligible.
export async function payInvoiceWithBackupCard(c: Context, stripe: Stripe, customerId: string, invoiceId: string, attempt: FailedAttempt = {}): Promise<BackupChargeResult> {
  const { backupPaymentMethod, subscriptionKnown } = await findSavedPaymentMethods(c, stripe, customerId)
  // Unknown lookup: do not treat as no_backup (that would skip the webhook retry and send dunning).
  if (!subscriptionKnown)
    throw simpleError('subscription_lookup_unknown', 'Subscription payment method is temporarily unknown')
  if (!backupPaymentMethod)
    return 'no_backup'
  // A failed backup charge fires charge.failed again: never retry the card that just failed.
  if (backupPaymentMethod.id === attempt.paymentMethodId)
    return 'failed_card_is_backup'
  const options = attempt.chargeId ? { idempotencyKey: `capgo-backup-${invoiceId}-${attempt.chargeId}` } : undefined
  try {
    const paid = await stripe.invoices.pay(invoiceId, { payment_method: backupPaymentMethod.id, off_session: true }, options)
    cloudlog({ requestId: c.get('requestId'), message: 'backup card charged', customerId, invoiceId, status: paid.status })
    return paid.status === 'paid' ? 'paid' : 'declined'
  }
  catch (error) {
    if (!isCardError(error))
      throw error
    cloudlog({ requestId: c.get('requestId'), message: 'backup card declined', customerId, invoiceId, code: getStripeErrorCode(error) })
    return 'declined'
  }
}

function getStripeErrorChargeId(error: unknown) {
  return error && typeof error === 'object' && 'charge' in error && typeof error.charge === 'string' ? error.charge : null
}

function getStripeErrorPaymentMethodId(error: unknown) {
  if (!error || typeof error !== 'object' || !('payment_method' in error))
    return null
  const paymentMethod = error.payment_method
  if (typeof paymentMethod === 'string')
    return paymentMethod
  if (paymentMethod && typeof paymentMethod === 'object' && 'id' in paymentMethod && typeof paymentMethod.id === 'string')
    return paymentMethod.id
  return null
}

function paymentMethodIdFromIntent(paymentIntent: Stripe.PaymentIntent | null) {
  if (!paymentIntent?.payment_method)
    return null
  return typeof paymentIntent.payment_method === 'string' ? paymentIntent.payment_method : paymentIntent.payment_method.id
}

export function parseCancelFeedback(value: unknown): CancelFeedback {
  if (typeof value === 'string' && (CANCEL_FEEDBACK_VALUES as readonly string[]).includes(value))
    return value as CancelFeedback
  throw simpleError('invalid_cancel_reason', 'A valid cancellation reason is required', { allowed: CANCEL_FEEDBACK_VALUES })
}

export function parseCancelComment(value: unknown) {
  if (value === undefined || value === null)
    return undefined
  if (typeof value !== 'string')
    throw simpleError('invalid_cancel_comment', 'Comment must be a string')
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, MAX_CANCEL_COMMENT_LENGTH) : undefined
}

async function requireActiveSubscriptionId(c: Context, ctx: InAppBillingContext) {
  const subscriptionId = await getActiveSubscriptionId(c, ctx.customerId)
  if (!subscriptionId)
    throw simpleError('no_active_subscription', 'No active subscription')
  return subscriptionId
}

// Ends at period end, like the portal did; the reason is kept on the Stripe subscription.
export async function scheduleSubscriptionCancel(c: Context, ctx: InAppBillingContext, feedback: CancelFeedback, comment?: string) {
  const subscriptionId = await requireActiveSubscriptionId(c, ctx)
  await releaseTrialPlanSchedule(c, ctx.stripe, subscriptionId)
  await ctx.stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
    cancellation_details: { feedback, ...(comment ? { comment } : {}) },
  })
  cloudlog({ requestId: c.get('requestId'), message: 'in-app subscription cancel scheduled', customerId: ctx.customerId, subscriptionId, feedback })
  await syncSubscriptionData(c, ctx.customerId, subscriptionId)
  return await getSubscriptionSummary(c, ctx)
}

export async function resumeSubscription(c: Context, ctx: InAppBillingContext) {
  const subscriptionId = await requireActiveSubscriptionId(c, ctx)
  await releaseTrialPlanSchedule(c, ctx.stripe, subscriptionId)
  // Clear both cancel styles: period end, and an explicit cancel_at date.
  await ctx.stripe.subscriptions.update(subscriptionId, {
    cancel_at: '',
    cancel_at_period_end: false,
    cancellation_details: { feedback: '', comment: '' },
  })
  await syncSubscriptionData(c, ctx.customerId, subscriptionId)
  return await getSubscriptionSummary(c, ctx)
}

async function getInvoicePaymentIntent(ctx: InAppBillingContext, invoiceId: string) {
  const payments = await ctx.stripe.invoicePayments.list({ invoice: invoiceId, limit: 10 })
  const pending = payments.data.find(payment => payment.status === 'open') ?? payments.data[0]
  const paymentIntent = pending?.payment?.payment_intent
  if (!paymentIntent)
    return null
  return typeof paymentIntent === 'string'
    ? await ctx.stripe.paymentIntents.retrieve(paymentIntent)
    : paymentIntent
}

function getStripeErrorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : ''
}

function getStripeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Payment failed'
}

function isCapgoError(error: unknown, errorCode: string) {
  if (!error || typeof error !== 'object' || !('cause' in error))
    return false
  const cause = error.cause
  return !!cause && typeof cause === 'object' && 'error' in cause && cause.error === errorCode
}

// Only after a real decline, and only while the invoice is still open.
async function tryBackupAfterDecline(c: Context, ctx: InAppBillingContext, invoiceId: string, attempt: FailedAttempt) {
  try {
    const invoice = await ctx.stripe.invoices.retrieve(invoiceId)
    if (invoice.status === 'paid')
      return true
    if (invoice.status !== 'open')
      return false
    // Exclude the card that just failed so Pay now cannot charge the backup against itself.
    const paymentMethodId = attempt.paymentMethodId ?? paymentMethodIdFromIntent(await getInvoicePaymentIntent(ctx, invoiceId))
    return await payInvoiceWithBackupCard(c, ctx.stripe, ctx.customerId, invoiceId, { chargeId: attempt.chargeId, paymentMethodId }) === 'paid'
  }
  catch (error) {
    // Let the caller surface a retryable lookup failure instead of the primary card decline.
    if (isCapgoError(error, 'subscription_lookup_unknown'))
      throw error
    cloudlogErr({ requestId: c.get('requestId'), message: 'in-app backup card fallback', customerId: ctx.customerId, invoiceId, error })
    return false
  }
}

// Retry the open renewal invoice with the default card; 3DS is finished client-side.
export async function payOpenInvoice(c: Context, ctx: InAppBillingContext): Promise<PayInvoiceResult> {
  const invoice = await findLatestOpenSubscriptionInvoice(c, ctx.customerId, ctx.billingAccount)
  if (!invoice?.id)
    return { status: 'paid' }
  try {
    const paid = await ctx.stripe.invoices.pay(invoice.id)
    if (paid.status === 'paid')
      return { status: 'paid' }
  }
  catch (error) {
    const code = getStripeErrorCode(error)
    cloudlog({ requestId: c.get('requestId'), message: 'in-app invoice pay failed', customerId: ctx.customerId, invoiceId: invoice.id, code })
    if (code !== 'invoice_payment_intent_requires_action') {
      if (isCardError(error) && await tryBackupAfterDecline(c, ctx, invoice.id, {
        chargeId: getStripeErrorChargeId(error),
        paymentMethodId: getStripeErrorPaymentMethodId(error),
      }))
        return { status: 'paid' }
      return { status: 'requires_payment_method', message: getStripeErrorMessage(error) }
    }
  }
  const paymentIntent = await getInvoicePaymentIntent(ctx, invoice.id)
  // Without Stripe.js there is no way to run 3DS here; ask for another card instead.
  if (paymentIntent?.status === 'requires_action' && paymentIntent.client_secret && ctx.publishableKey)
    return { status: 'requires_action', clientSecret: paymentIntent.client_secret, publishableKey: ctx.publishableKey }
  if (paymentIntent?.status === 'succeeded')
    return { status: 'paid' }
  return { status: 'requires_payment_method', message: paymentIntent?.last_payment_error?.message ?? 'Payment failed' }
}

// Lets the user pay the open invoice with a new card in one step (Payment Element).
export async function getOpenInvoicePaymentSecret(c: Context, ctx: InAppBillingContext) {
  const publishableKey = requirePublishableKey(ctx)
  const invoice = await findLatestOpenSubscriptionInvoice(c, ctx.customerId, ctx.billingAccount)
  if (!invoice?.id)
    return null
  const paymentIntent = await getInvoicePaymentIntent(ctx, invoice.id)
  if (!paymentIntent?.client_secret || paymentIntent.status === 'succeeded' || paymentIntent.status === 'canceled')
    return null
  if (paymentIntent.setup_future_usage !== 'off_session') {
    // Save the new card so the next renewal does not fail again.
    await ctx.stripe.paymentIntents.update(paymentIntent.id, { setup_future_usage: 'off_session' })
  }
  return { clientSecret: paymentIntent.client_secret, publishableKey }
}
