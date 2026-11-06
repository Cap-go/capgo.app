import type { Stripe } from '@stripe/stripe-js'
import { loadStripe } from '@stripe/stripe-js'
import { toast } from 'vue-sonner'
import { i18n } from '~/modules/i18n'
import { invokeCapgoApi } from '~/services/capgoApi'
import { getFormatLocale } from '~/services/formatLocale'
import { stripeAmountToMajorUnits } from '../../supabase/functions/shared/stripe-amount.ts'

interface CheckoutSessionResponse {
  url?: string | null
  clientSecret?: string | null
  publishableKey?: string
  sessionId?: string
}

// Embedded sessions mount in Capgo; hosted is only returned by the local Stripe emulator.
export type CheckoutSession
  = | { kind: 'embedded', clientSecret: string, publishableKey: string, sessionId: string }
    | { kind: 'hosted', url: string }

function toCheckoutSession(data: CheckoutSessionResponse): CheckoutSession | null {
  if (data.clientSecret && data.publishableKey && data.sessionId)
    return { kind: 'embedded', clientSecret: data.clientSecret, publishableKey: data.publishableKey, sessionId: data.sessionId }
  if (data.url)
    return { kind: 'hosted', url: data.url }
  return null
}

const stripeInstances = new Map<string, Promise<Stripe | null>>()

// One Stripe.js instance per account key (EE and US orgs use different accounts).
export function getStripeJs(publishableKey: string) {
  let instance = stripeInstances.get(publishableKey)
  if (!instance) {
    // Forget failed loads (network error, blocker) so a retry can try again.
    instance = loadStripe(publishableKey).then((stripe) => {
      if (!stripe)
        stripeInstances.delete(publishableKey)
      return stripe
    }, (error) => {
      stripeInstances.delete(publishableKey)
      throw error
    })
    stripeInstances.set(publishableKey, instance)
  }
  return instance
}

async function getCookieValue(name: string) {
  if ('cookieStore' in globalThis && globalThis.cookieStore)
    return (await globalThis.cookieStore.get(name))?.value

  if (typeof document === 'undefined')
    return undefined

  const encodedName = `${encodeURIComponent(name)}=`
  const cookie = document.cookie.split('; ').find(cookie => cookie.startsWith(encodedName))
  return cookie ? decodeURIComponent(cookie.slice(encodedName.length)) : undefined
}

export async function getDatafastAttribution() {
  return {
    visitorId: await getCookieValue('datafast_visitor_id'),
    sessionId: await getCookieValue('datafast_session_id'),
  }
}

export async function getAffonsoReferral() {
  try {
    const referral = await getCookieValue('affonso_referral')
    // Stripe metadata values are capped at 500 characters.
    return referral && referral.length <= 500 ? referral : ''
  }
  catch {
    return ''
  }
}

export interface SubscriptionCheckoutRequest {
  priceId: string
  successUrl: string
  cancelUrl: string
  isYear: boolean
  orgId: string
  extraMau?: number
  // One of the currencies returned by private/plan_prices.
  currency?: string
  // Buy the full price instead of the regional discount.
  standardPrice?: boolean
}

export async function startSubscriptionCheckout(request: SubscriptionCheckoutRequest): Promise<CheckoutSession | null> {
  const datafastAttribution = await getDatafastAttribution()
  const affonsoReferral = await getAffonsoReferral()
  const { data, error } = await invokeCapgoApi<CheckoutSessionResponse>('private/stripe_checkout', {
    body: JSON.stringify({
      priceId: request.priceId,
      successUrl: request.successUrl,
      cancelUrl: request.cancelUrl,
      recurrence: request.isYear ? 'year' : 'month',
      orgId: request.orgId,
      attributionId: datafastAttribution.visitorId,
      datafastVisitorId: datafastAttribution.visitorId,
      datafastSessionId: datafastAttribution.sessionId,
      affonsoReferral,
      embedded: true,
      ...(request.extraMau ? { extraMau: request.extraMau } : {}),
      ...(request.currency ? { currency: request.currency } : {}),
      ...(request.standardPrice ? { standardPrice: true } : {}),
    }),
  })
  if (error || !data) {
    console.error('Cannot start subscription checkout', error)
    return null
  }
  return toCheckoutSession(data)
}

export async function startCreditTopUp(orgId: string, quantity = 100): Promise<CheckoutSession> {
  const datafastAttribution = await getDatafastAttribution()
  const affonsoReferral = await getAffonsoReferral()
  const { data, error } = await invokeCapgoApi<CheckoutSessionResponse>('private/credits/start-top-up', {
    body: JSON.stringify({
      orgId,
      quantity,
      datafastVisitorId: datafastAttribution.visitorId,
      datafastSessionId: datafastAttribution.sessionId,
      affonsoReferral,
      embedded: true,
    }),
  })
  const session = !error && data ? toCheckoutSession(data) : null
  if (!session) {
    console.error('Cannot start credit top-up checkout', error ?? data)
    toast.error(i18n.global.t('billing-checkout-error'))
    throw error ?? new Error('Missing checkout session')
  }
  return session
}

export async function completeCreditTopUp(orgId: string, sessionId?: string | null) {
  if (!orgId)
    return null

  try {
    const { data, error } = await invokeCapgoApi('private/credits/complete-top-up', {
      body: JSON.stringify({
        orgId,
        ...(sessionId ? { sessionId } : {}),
      }),
    })
    if (error) {
      console.error('Failed to complete credit top-up', error)
      throw error
    }
    return data?.grant ?? null
  }
  catch (error) {
    console.error('Cannot complete credit top-up', error)
    toast.error('Cannot finalize credit checkout')
    throw error
  }
}

export async function getCreditAutoTopUp(orgId: string) {
  if (!orgId)
    return null
  const { data, error } = await invokeCapgoApi(`private/credits/auto-top-up?orgId=${encodeURIComponent(orgId)}`, {
    method: 'GET',
  })
  if (error) {
    console.error('Failed to load credit auto top-up', error)
    throw error
  }
  return data as {
    enabled: boolean
    threshold: number
    hasPaymentMethod: boolean
    availableCredits: number
    monthlyLimit: number
    monthlyTotal: number | null
  } | null
}

export async function saveCreditAutoTopUp(orgId: string, enabled: boolean, threshold: number, monthlyLimit: number) {
  if (!orgId)
    return null
  const { data, error } = await invokeCapgoApi('private/credits/auto-top-up', {
    body: JSON.stringify({ orgId, enabled, threshold, monthlyLimit }),
  })
  if (error) {
    console.error('Failed to save credit auto top-up', error)
    throw error
  }
  return data as {
    enabled: boolean
    threshold: number
    hasPaymentMethod: boolean
    availableCredits: number
    monthlyLimit: number
    monthlyTotal: number | null
  } | null
}

interface PastDueInvoice {
  hosted_invoice_url: string | null
  amount_due: number
  currency: string
  attempt_count: number
  next_payment_attempt: string | null
}

export interface PastDueStatus {
  past_due: boolean
  invoice: PastDueInvoice | null
}

export async function getPastDueStatus(orgId: string): Promise<PastDueStatus | null> {
  if (!orgId)
    return null
  const { data, error } = await invokeCapgoApi<PastDueStatus>('private/stripe_past_due', {
    body: JSON.stringify({ orgId }),
  })
  if (error || !data)
    return null
  return data
}

export interface BillingCard {
  id: string
  brand: string
  last4: string
  expMonth: number
  expYear: number
}

export interface BillingSubscription {
  status: string
  cancelAtPeriodEnd: boolean
  cancelAt: string | null
  currentPeriodEnd: string | null
}

export interface BillingInvoice {
  id: string
  number: string | null
  created: string
  total: number
  amountDue: number
  currency: string
  status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void' | null
  pdfUrl: string | null
}

// The onboarding plan that starts (and is first charged) when the free trial ends.
export interface TrialPlan {
  planName: string
  productId: string
  amount: number
  currency: string
  interval: 'month'
  startsAt: string
  scheduled: boolean
}

// Solo / Maker / Team choices shown when saving a card to auto-start a plan.
export interface TrialPlanOption {
  productId: string
  planName: string
  amount: number
  currency: string
  // Full price when a regional discount applies (it needs a card and billing address from that region).
  regularAmount?: number
}

export interface BillingOverview {
  publishableKey: string
  card: BillingCard | null
  // Charged automatically when the default card fails a renewal.
  backupCard: BillingCard | null
  subscription: BillingSubscription | null
  invoices: BillingInvoice[]
  openInvoice: { id: string, amountDue: number, currency: string } | null
  trialPlan: TrialPlan | null
}

export const CANCEL_REASONS = [
  'too_expensive',
  'missing_features',
  'switched_service',
  'unused',
  'too_complex',
  'low_quality',
  'customer_service',
  'other',
] as const

export type CancelReason = typeof CANCEL_REASONS[number]

export interface IntentSecret {
  clientSecret: string
  publishableKey: string
}

type PayInvoiceResponse
  = | { status: 'paid' }
    | { status: 'requires_action', clientSecret: string, publishableKey: string }
    | { status: 'requires_payment_method', message: string }

export type PayInvoiceResult = Exclude<PayInvoiceResponse, { status: 'requires_action' }>

async function callBilling<T>(path: string, body: Record<string, unknown>) {
  const { data, error } = await invokeCapgoApi<T>(`private/stripe_billing/${path}`, {
    body: JSON.stringify(body),
  })
  if (error || !data)
    throw error ?? new Error(`Empty billing response for ${path}`)
  return data
}

export function getBillingOverview(orgId: string) {
  return callBilling<BillingOverview>('overview', { orgId })
}

export function getTrialPlan(orgId: string) {
  return callBilling<{ card: BillingCard | null, plan: TrialPlan | null, plans: TrialPlanOption[] }>('trial-plan', { orgId })
}

export async function scheduleTrialPlan(orgId: string, productId?: string) {
  const datafastAttribution = await getDatafastAttribution()
  const affonsoReferral = await getAffonsoReferral()
  return callBilling<{ plan: TrialPlan }>('trial-plan/schedule', {
    orgId,
    ...(productId ? { productId } : {}),
    affonsoReferral,
    datafastVisitorId: datafastAttribution.visitorId,
    datafastSessionId: datafastAttribution.sessionId,
  })
}

// Starts the trial plan today: charges the saved card now and restarts the billing cycle.
export async function startTrialPlanNow(orgId: string, productId?: string) {
  const datafastAttribution = await getDatafastAttribution()
  const affonsoReferral = await getAffonsoReferral()
  return callBilling<{ plan: TrialPlan, subscriptionId: string }>('trial-plan/start-now', {
    orgId,
    ...(productId ? { productId } : {}),
    affonsoReferral,
    datafastVisitorId: datafastAttribution.visitorId,
    datafastSessionId: datafastAttribution.sessionId,
  })
}

export function cancelTrialPlan(orgId: string) {
  return callBilling<{ plan: TrialPlan | null }>('trial-plan/cancel', { orgId })
}

export function createCardSetupIntent(orgId: string) {
  return callBilling<IntentSecret>('setup-intent', { orgId })
}

export function getInvoicePaymentIntent(orgId: string) {
  return callBilling<IntentSecret>('invoice-payment-intent', { orgId })
}

// intentId is the confirmed SetupIntent (new card) or PaymentIntent (invoice paid with a new card).
export function savePaymentMethod(orgId: string, intentId: string, role: 'default' | 'backup' = 'default') {
  return callBilling<{ card: BillingCard | null }>('payment-method', { orgId, intentId, role })
}

export function removeBackupCard(orgId: string, paymentMethodId: string) {
  return callBilling<{ card: BillingCard | null, backupCard: BillingCard | null }>('remove-backup-card', { orgId, paymentMethodId })
}

// Discount offered to stay instead of canceling a monthly plan.
export interface CancelSaveOffer {
  id: string
  percentOff: number
  durationMonths: number
  // Minor units, like every Stripe amount.
  monthlyAmount: number
  discountedAmount: number
  currency: string
}

export function getCancelSaveOffer(orgId: string, reason: CancelReason) {
  return callBilling<{ offer: CancelSaveOffer | null }>('cancel-offer', { orgId, reason })
}

export function acceptCancelSaveOffer(orgId: string, offerId: string) {
  return callBilling<{ discountEnd: string, subscription: BillingSubscription | null }>('cancel-offer/accept', { orgId, offerId })
}

// offerId: the save offer the customer turned down before canceling.
export function cancelSubscriptionWithReason(orgId: string, reason: CancelReason, comment: string, offerId?: string) {
  return callBilling<{ subscription: BillingSubscription | null }>('cancel', { orgId, reason, comment, ...(offerId ? { offerId } : {}) })
}

export function resumeSubscription(orgId: string) {
  return callBilling<{ subscription: BillingSubscription | null }>('resume', { orgId })
}

// Pays the open renewal invoice with the saved card and finishes 3DS in place when asked.
export async function payOpenInvoice(orgId: string): Promise<PayInvoiceResult> {
  const result = await callBilling<PayInvoiceResponse>('pay-invoice', { orgId })
  if (result.status !== 'requires_action')
    return result
  const stripe = await getStripeJs(result.publishableKey)
  if (!stripe)
    return { status: 'requires_payment_method', message: i18n.global.t('billing-stripe-load-error') }
  const { error, paymentIntent } = await stripe.handleNextAction({ clientSecret: result.clientSecret })
  if (error || paymentIntent?.status !== 'succeeded')
    return { status: 'requires_payment_method', message: error?.message ?? i18n.global.t('billing-payment-failed') }
  return { status: 'paid' }
}

export function formatStripeAmount(amount: number, currency: string) {
  const value = stripeAmountToMajorUnits(amount, currency)
  try {
    return new Intl.NumberFormat(getFormatLocale(), { style: 'currency', currency: currency.toUpperCase() }).format(value)
  }
  catch {
    return `${value} ${currency.toUpperCase()}`
  }
}
