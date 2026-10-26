import type { Context } from 'hono'
import type { BillingAccount } from './stripe_billing.ts'
import type { Database } from './supabase.types.ts'
import Stripe from 'stripe'
import { simpleError } from './hono.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import {
  BillingAccountUnavailableError,
  getBillingAccountForCustomer,
  getPlanPriceId,
  getStripePublishableKey,
  getStripeSecretKey,
  isAutomaticTaxEnabled,
  isStripeConfiguredForAccount,
  planProductIdOrFilter,
  resolveCheckoutPlanProductId,
  TRIAL_PLAN_SCHEDULE_METADATA_KEY,
} from './stripe_billing.ts'
import { supabaseAdmin } from './supabase.ts'
import { getEnv, isStripeConfigured, trimTrailingSlashes } from './utils.ts'

export type { BillingAccount } from './stripe_billing.ts'
export {
  findPlanByProductId,
  getBillingAccountForCustomer,
  getPlanCreditProductId,
  getPlanProductId,
  getStripeWebhookSecret,
  isStripeConfiguredForAccount,
  normalizeBillingAccount,
  planProductIdOrFilter,
  resolvePlanCreditProductId,
} from './stripe_billing.ts'

const TRACKED_STRIPE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due'] as const
const ISO_COUNTRY_CODE_REGEX = /^[A-Z]{2}$/

// Checks if SUPABASE_URL points to a local instance
function isLocalSupabase(c: Context): boolean {
  const supabaseUrl = getEnv(c, 'SUPABASE_URL')
  if (!supabaseUrl)
    return false
  return supabaseUrl.includes('127.0.0.1') || supabaseUrl.includes('localhost')
}

// Extracts the Supabase project ID from SUPABASE_URL
// e.g., "https://sb.capgo.app" -> "sb.capgo.app"
function getSupabaseProjectId(c: Context): string | null {
  const supabaseUrl = getEnv(c, 'SUPABASE_URL')
  if (!supabaseUrl)
    return null
  return supabaseUrl.split('//')[1]?.split('.')[0]?.split(':')[0] || null
}

// Builds a Supabase dashboard link to the orgs table filtered by customer_id
function buildSupabaseDashboardLink(c: Context, customerId: string): string | null {
  const supabaseUrl = getEnv(c, 'SUPABASE_URL')
  if (!supabaseUrl)
    return null

  // Local Supabase Studio runs on API port + 2 (default: 54321 -> 54323).
  if (isLocalSupabase(c)) {
    try {
      const api = new URL(supabaseUrl)
      const apiPort = Number.parseInt(api.port || '54321', 10)
      const studioPort = apiPort + 2
      return `${api.protocol}//${api.hostname}:${studioPort}/project/default/editor/445780?schema=public&filter=customer_id%3Aeq%3A${customerId}`
    }
    catch {
      return `http://127.0.0.1:54323/project/default/editor/445780?schema=public&filter=customer_id%3Aeq%3A${customerId}`
    }
  }

  const projectId = getSupabaseProjectId(c)
  if (!projectId)
    return null
  // 445780 is the orgs table ID in Supabase
  return `https://supabase.com/dashboard/project/${projectId}/editor/445780?schema=public&filter=customer_id%3Aeq%3A${customerId}`
}

export type StripeEnvironment = 'live' | 'test'

export function resolveStripeEnvironment(c: Context, account: BillingAccount = 'ee'): StripeEnvironment {
  const secretKey = getStripeSecretKey(c, account) || ''
  if (secretKey.startsWith('sk_live') || secretKey.startsWith('rk_live'))
    return 'live'
  return 'test'
}

function isLocalStripeEmulatorHost(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '[::1]'
    || hostname === '::1'
    || hostname === 'host.docker.internal'
}

function isLocalStripeEmulatorConfig(c: Context, secretKey: string): boolean {
  return getEnv(c, 'ENV') === 'local' && secretKey === 'sk_test_emulator'
}

function assertStripeApiBaseUrlAllowed(
  c: Context,
  account: BillingAccount,
  secretKey: string,
  apiBaseUrl: URL | null,
): void {
  if (!apiBaseUrl || apiBaseUrl.protocol !== 'http:')
    return

  if (resolveStripeEnvironment(c, account) === 'live') {
    throw new Error('STRIPE_API_BASE_URL must use https when using live Stripe credentials')
  }

  if (apiBaseUrl.hostname === 'host.docker.internal' && !isLocalStripeEmulatorConfig(c, secretKey)) {
    throw new Error('STRIPE_API_BASE_URL host.docker.internal is only allowed for local emulator config')
  }

  if (!isLocalStripeEmulatorHost(apiBaseUrl.hostname)) {
    throw new Error('STRIPE_API_BASE_URL must use https for non-loopback hosts')
  }
}

function getStripeApiBaseUrl(c: Context): URL | null {
  const rawBaseUrl = getEnv(c, 'STRIPE_API_BASE_URL').trim()
  if (!rawBaseUrl)
    return null

  let parsedBaseUrl: URL
  try {
    parsedBaseUrl = new URL(rawBaseUrl)
  }
  catch {
    throw new Error('Invalid STRIPE_API_BASE_URL')
  }

  if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) {
    throw new Error('STRIPE_API_BASE_URL must use http or https')
  }

  if (parsedBaseUrl.pathname !== '/' && parsedBaseUrl.pathname !== '') {
    throw new Error('STRIPE_API_BASE_URL must not include a path')
  }

  return parsedBaseUrl
}

export function isStripeEmulatorEnabled(c: Context): boolean {
  return getStripeApiBaseUrl(c) !== null
}

export function getStripe(c: Context, account: BillingAccount = 'ee'): Stripe {
  const secretKey = getStripeSecretKey(c, account).trim()
  if (!secretKey) {
    throw simpleError(
      'stripe_not_configured',
      `Stripe secret key is not configured for billing account ${account}`,
      { account },
    )
  }

  const apiBaseUrl = getStripeApiBaseUrl(c)
  assertStripeApiBaseUrlAllowed(c, account, secretKey, apiBaseUrl)
  const apiPort = apiBaseUrl
    ? Number.parseInt(apiBaseUrl.port || (apiBaseUrl.protocol === 'https:' ? '443' : '80'), 10)
    : undefined
  type StripeApiVersion = NonNullable<ConstructorParameters<typeof Stripe>[1]>['apiVersion']

  return new Stripe(secretKey, {
    // Keep the pinned runtime API version even when the installed SDK types lag behind it.
    apiVersion: '2026-03-25.dahlia' as StripeApiVersion,
    httpClient: Stripe.createFetchHttpClient(),
    ...(apiBaseUrl
      ? {
          host: apiBaseUrl.hostname,
          port: apiPort,
          protocol: apiBaseUrl.protocol.replace(':', '') as 'http' | 'https',
        }
      : {}),
  })
}

// The plan item: the Enterprise extra MAU item is licensed too, so skip it.
function getLicensedSubscriptionItem(items: Stripe.SubscriptionItem[] | undefined) {
  const planItems = items?.filter(item => !isExtraMauItem(item))
  return planItems?.find(item => item.plan.usage_type === 'licensed') ?? planItems?.[0] ?? null
}

function buildStripeContext(c: Context, billingAccount: BillingAccount) {
  const configured = isStripeConfiguredForAccount(c, billingAccount)
  if (!configured) {
    return {
      billingAccount,
      configured: false as const,
      stripe: null,
    }
  }

  return {
    billingAccount,
    configured: true as const,
    stripe: getStripe(c, billingAccount),
  }
}

async function getStripeContextForCustomer(c: Context, customerId: string) {
  const billingAccount = await getBillingAccountForCustomer(c, customerId)
  return buildStripeContext(c, billingAccount)
}

// EE without a key is the local/dev no-Stripe mode. Any other account without a key holds real
// customers we can no longer reach, so fail loudly instead of faking success.
function assertBillingAccountReachable(c: Context, billingAccount: BillingAccount, customerId: string) {
  if (billingAccount === 'ee' || isStripeConfiguredForAccount(c, billingAccount))
    return
  cloudlogErr({ requestId: c.get('requestId'), message: 'Stripe account not configured for customer', billingAccount, customerId })
  throw new BillingAccountUnavailableError(billingAccount)
}

function assertBillingAccountReachableForUser(c: Context, billingAccount: BillingAccount, customerId: string) {
  try {
    assertBillingAccountReachable(c, billingAccount, customerId)
  }
  catch (error) {
    throw simpleError('billing_account_unavailable', 'Billing is temporarily unavailable for this organization', { billingAccount }, error)
  }
}

function getSubscriptionProductId(c: Context, item: Stripe.SubscriptionItem | null) {
  if (!item)
    return null

  const price = item.price
  if (typeof price === 'object' && price !== null && typeof price.product === 'string')
    return price.product

  cloudlog({ requestId: c.get('requestId'), message: 'Price or product data missing/invalid type in subscription item', itemId: item.id })
  return null
}

function stripeTimestampToIso(seconds: number | null | undefined) {
  return seconds ? new Date(seconds * 1000).toISOString() : null
}

function getSubscriptionEndDate(subscription: Stripe.Subscription, item: Stripe.SubscriptionItem | null) {
  const endSeconds = subscription.ended_at
    ?? subscription.cancel_at
    ?? (subscription.cancel_at_period_end ? item?.current_period_end : null)
    ?? null

  return stripeTimestampToIso(endSeconds)
}

export async function getSubscriptionData(c: Context, customerId: string, subscriptionId: string | null, billingAccount?: BillingAccount) {
  if (!subscriptionId)
    return null
  try {
    cloudlog({ requestId: c.get('requestId'), message: 'Fetching subscription data', customerId, subscriptionId })

    const stripeContext = billingAccount
      ? buildStripeContext(c, billingAccount)
      : await getStripeContextForCustomer(c, customerId)
    if (!stripeContext.configured)
      return null

    // Retrieve the specific subscription from Stripe
    const subscription = await stripeContext.stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price', 'latest_invoice'], // Correct expand path for retrieve
    })

    cloudlog({
      requestId: c.get('requestId'),
      context: 'getSubscriptionData',
      // subscriptionsFound: subscriptions.data.length, // Removed - retrieve returns one or throws
      subscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
    })

    const currentItem = getLicensedSubscriptionItem(subscription.items.data)
    const productId = getSubscriptionProductId(c, currentItem)
    const cycleStart = stripeTimestampToIso(currentItem?.current_period_start)
    const cycleEnd = stripeTimestampToIso(currentItem?.current_period_end)
    const canceledAt = getSubscriptionEndDate(subscription, currentItem)

    // A trial plan subscription only converts once its first invoice is paid (see stripe_trial_plan.ts).
    const latestInvoice = typeof subscription.latest_invoice === 'object' ? subscription.latest_invoice : null
    const trialPlanFirstInvoiceUnpaid = subscription.metadata?.[TRIAL_PLAN_SCHEDULE_METADATA_KEY] === 'true'
      && latestInvoice?.billing_reason === 'subscription_create'
      && latestInvoice.status !== 'paid'

    return {
      productId,
      extraMau: getExtraMau(subscription.items.data),
      status: subscription.status,
      trialPlanFirstInvoiceUnpaid,
      cycleStart,
      cycleEnd,
      canceledAt,
      subscriptionId: subscription.id,
      cancel_at_period_end: subscription.cancel_at_period_end,
    }
  }
  catch (error) {
    // Handle specific Stripe errors if needed, e.g., resource_missing
    if (error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'resource_missing') {
      cloudlog({ requestId: c.get('requestId'), message: 'Subscription not found', subscriptionId, error: error.code })
    }
    else {
      cloudlogErr({ requestId: c.get('requestId'), message: 'getSubscriptionData', error })
    }
    return null
  }
}

async function getActiveSubscription(c: Context, customerId: string, subscriptionId: string | null, billingAccount?: BillingAccount) {
  cloudlog({ requestId: c.get('requestId'), message: 'Stored subscription not tracked or not found, checking for others.', customerId, storedSubscriptionId: subscriptionId })

  const stripeContext = billingAccount
    ? buildStripeContext(c, billingAccount)
    : await getStripeContextForCustomer(c, customerId)
  if (!stripeContext.configured)
    return null

  for (const status of TRACKED_STRIPE_SUBSCRIPTION_STATUSES) {
    const subscriptions = await stripeContext.stripe.subscriptions.list({
      customer: customerId,
      status,
      limit: 1,
    })

    if (subscriptions.data.length > 0) {
      const activeSub = subscriptions.data[0]
      cloudlog({ requestId: c.get('requestId'), message: 'Found a tracked subscription, fetching its data.', activeSubscriptionId: activeSub.id, status: activeSub.status })
      return getSubscriptionData(c, customerId, activeSub.id, stripeContext.billingAccount)
    }
  }

  cloudlog({ requestId: c.get('requestId'), message: 'No other tracked subscriptions found for customer.', customerId })
  return null
}

export async function syncSubscriptionData(c: Context, customerId: string, subscriptionId: string | null): Promise<void> {
  const billingAccount = await getBillingAccountForCustomer(c, customerId)
  if (!isStripeConfiguredForAccount(c, billingAccount))
    return
  try {
    // Get subscription data from Stripe using the ID stored in our DB
    let subscriptionData = await getSubscriptionData(c, customerId, subscriptionId, billingAccount)

    if (!subscriptionData) {
      subscriptionData = await getActiveSubscription(c, customerId, subscriptionId, billingAccount)
    }
    else if (!TRACKED_STRIPE_SUBSCRIPTION_STATUSES.includes(subscriptionData.status as typeof TRACKED_STRIPE_SUBSCRIPTION_STATUSES[number])) {
      const replacementSubscriptionData = await getActiveSubscription(c, customerId, subscriptionId, billingAccount)
      if (replacementSubscriptionData || subscriptionData.status !== 'canceled')
        subscriptionData = replacementSubscriptionData
    }

    let dbStatus: Database['public']['Enums']['stripe_status'] = 'canceled'

    if (subscriptionData) {
      if (subscriptionData.status === 'canceled') {
        // Paid access runs to period end, but a never-paid trial plan grants none.
        if (subscriptionData.cycleEnd && new Date(subscriptionData.cycleEnd) > new Date() && !subscriptionData.trialPlanFirstInvoiceUnpaid)
          dbStatus = 'succeeded'
      }
      else if (subscriptionData.trialPlanFirstInvoiceUnpaid) {
        // Live in Stripe but never paid: keep the org non-paying, as the webhook does.
        dbStatus = 'failed'
      }
      else if (subscriptionData.status === 'active' || subscriptionData.status === 'trialing' || subscriptionData.status === 'past_due') {
        dbStatus = 'succeeded'
      }
    }

    const { data: currentStripeInfo, error: currentStripeInfoError } = await supabaseAdmin(c)
      .from('stripe_info')
      .select('status, past_due_at')
      .eq('customer_id', customerId)
      .maybeSingle()

    if (currentStripeInfoError) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'syncSubscriptionData current stripe_info', error: currentStripeInfoError })
      return
    }

    const hadPastDueState = !!currentStripeInfo?.past_due_at

    // Update stripe_info table with latest data, even if no subscription exists
    const updateData: any = {
      status: dbStatus,
    }

    if (subscriptionData?.status === 'past_due') {
      updateData.past_due_at = currentStripeInfo?.past_due_at ?? new Date().toISOString()
      updateData.churn_reason = null
    }
    else if (hadPastDueState) {
      updateData.past_due_at = null
      updateData.churn_reason = dbStatus === 'canceled' ? 'past_due_unresolved' : null
    }

    // Only include fields if they have valid values to avoid foreign key constraint violations
    if (subscriptionData?.productId) {
      updateData.product_id = subscriptionData.productId
    }
    if (subscriptionData?.subscriptionId) {
      updateData.subscription_id = subscriptionData.subscriptionId
    }
    if (subscriptionData?.cycleStart) {
      updateData.subscription_anchor_start = subscriptionData.cycleStart
    }
    if (subscriptionData?.cycleEnd) {
      updateData.subscription_anchor_end = subscriptionData.cycleEnd
    }
    if (subscriptionData)
      updateData.canceled_at = subscriptionData.canceledAt ?? null
    // Extra MAU only counts while the subscription that bought it is live.
    updateData.extra_mau = dbStatus === 'succeeded' ? subscriptionData?.extraMau ?? 0 : 0

    const { error: updateError } = await supabaseAdmin(c)
      .from('stripe_info')
      .update(updateData)
      .eq('customer_id', customerId)

    if (updateError) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'syncSubscriptionData', error: updateError })
    }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'syncSubscriptionData', error })
  }
}

export type PortalFlow = 'cancel_subscription'

// known is false on a stripe_info read error: the subscription may exist, so callers must not
// treat null as "no subscription" for destructive work (e.g. spare-card detach).
export async function lookupActiveSubscriptionId(c: Context, customerId: string) {
  const { data, error } = await supabaseAdmin(c)
    .from('stripe_info')
    .select('subscription_id, status')
    .eq('customer_id', customerId)
    .maybeSingle()
  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'getActiveSubscriptionId', error })
    return { subscriptionId: null as string | null, known: false }
  }
  if (!data?.subscription_id || data.status === 'canceled' || data.status === 'deleted')
    return { subscriptionId: null as string | null, known: true }
  return { subscriptionId: data.subscription_id, known: true }
}

export async function getActiveSubscriptionId(c: Context, customerId: string) {
  const { subscriptionId } = await lookupActiveSubscriptionId(c, customerId)
  return subscriptionId
}

export async function createPortal(c: Context, customerId: string, callbackUrl: string, flow?: PortalFlow) {
  const { stripe, configured, billingAccount } = await getStripeContextForCustomer(c, customerId)
  assertBillingAccountReachableForUser(c, billingAccount, customerId)
  if (!configured)
    return { url: '' }
  const allowedReturnUrl = getAllowedRedirectUrl(c, callbackUrl, 'return_url')
  if (flow === 'cancel_subscription') {
    const subscriptionId = await getActiveSubscriptionId(c, customerId)
    if (subscriptionId) {
      try {
        const session = await stripe.billingPortal.sessions.create({
          customer: customerId,
          return_url: allowedReturnUrl,
          flow_data: {
            type: 'subscription_cancel',
            subscription_cancel: { subscription: subscriptionId },
            after_completion: { type: 'redirect', redirect: { return_url: allowedReturnUrl } },
          },
        })
        return { url: session.url }
      }
      catch (error) {
        // Cancel flow can be rejected (already canceling, portal config); fall back to the plain portal.
        cloudlogErr({ requestId: c.get('requestId'), message: 'createPortal cancel flow failed', error })
      }
    }
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: allowedReturnUrl,
  })
  return { url: session.url }
}

export async function updateCustomerEmail(c: Context, customerId: string, newEmail: string) {
  const { stripe, configured } = await getStripeContextForCustomer(c, customerId)
  if (!configured)
    return
  return stripe.customers.update(customerId, { email: newEmail, metadata: { email: newEmail } },
  )
}

export async function updateCustomerOrganizationName(c: Context, customerId: string, newName: string) {
  const { stripe, configured } = await getStripeContextForCustomer(c, customerId)
  if (!configured)
    return
  return stripe.customers.update(customerId, { name: newName })
}

export async function getStripeCustomerName(c: Context, customerId: string | null | undefined): Promise<string | null | undefined> {
  if (!customerId)
    return undefined
  const { stripe, configured } = await getStripeContextForCustomer(c, customerId)
  if (!configured)
    return undefined

  try {
    const customer = await stripe.customers.retrieve(customerId)
    if (customer.deleted)
      return null
    return customer.name ?? null
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'getStripeCustomerName', customerId, error })
    return undefined
  }
}

export function isDeterministicStripeCustomerUpdateError(error: unknown) {
  return error instanceof Stripe.errors.StripeAuthenticationError
    || error instanceof Stripe.errors.StripeInvalidRequestError
    || error instanceof Stripe.errors.StripePermissionError
    || error instanceof Stripe.errors.StripeRateLimitError
}

export function normalizeStripeCountryCode(country: string | null | undefined): string | null {
  if (!country)
    return null

  const normalized = country.trim().toUpperCase()
  if (!normalized || !ISO_COUNTRY_CODE_REGEX.test(normalized))
    return null

  return normalized
}

export async function getStripeCustomerCountry(c: Context, customerId: string | null | undefined): Promise<string | null | undefined> {
  if (!customerId)
    return undefined
  const { stripe, configured } = await getStripeContextForCustomer(c, customerId)
  if (!configured)
    return undefined

  try {
    const customer = await stripe.customers.retrieve(customerId)
    if (customer.deleted)
      return null
    return normalizeStripeCountryCode(customer.address?.country ?? null)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'getStripeCustomerCountry', customerId, error })
    return undefined
  }
}

export async function syncStripeCustomerCountry(c: Context, customerId: string | null | undefined): Promise<string | null | undefined> {
  if (!customerId)
    return undefined
  const billingAccount = await getBillingAccountForCustomer(c, customerId)
  if (!isStripeConfiguredForAccount(c, billingAccount))
    return undefined

  const customerCountry = await getStripeCustomerCountry(c, customerId)
  if (customerCountry === undefined)
    return undefined

  const { data, error } = await supabaseAdmin(c)
    .from('stripe_info')
    .update({ customer_country: customerCountry })
    .eq('customer_id', customerId)
    .select('customer_id')

  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'syncStripeCustomerCountry', customerId, error })
  }
  else if (!data?.length) {
    cloudlog({ requestId: c.get('requestId'), message: 'syncStripeCustomerCountry no stripe_info row matched', customerId, customerCountry })
  }

  return customerCountry
}

export async function cancelSubscription(c: Context, customerId: string) {
  const { stripe, configured, billingAccount } = await getStripeContextForCustomer(c, customerId)
  assertBillingAccountReachable(c, billingAccount, customerId)
  if (!configured)
    return

  let succeeded = true
  for await (const subscription of stripe.subscriptions.list({ customer: customerId, status: 'all' })) {
    if (subscription.status === 'canceled' || subscription.status === 'incomplete_expired')
      continue

    try {
      await stripe.subscriptions.cancel(subscription.id)
    }
    catch (error) {
      succeeded = false
      cloudlogErr({ requestId: c.get('requestId'), message: 'cancelSubscription item', error, subscriptionId: subscription.id, customerId })
    }
  }
  return succeeded
}

// Unpaid subscription invoice details safe to show to billing members.
export interface OpenSubscriptionInvoiceSummary {
  hosted_invoice_url: string | null
  amount_due: number
  currency: string
  attempt_count: number
  next_payment_attempt: string | null
}

type OpenInvoiceShape = Pick<Stripe.Invoice, 'amount_due' | 'attempt_count' | 'billing_reason' | 'created' | 'currency' | 'next_payment_attempt'> & {
  amount_remaining?: number | null
  hosted_invoice_url?: string | null
  parent?: { subscription_details?: unknown } | null
}

export function isSubscriptionInvoice(invoice: Pick<OpenInvoiceShape, 'billing_reason' | 'parent'>) {
  if (invoice.parent?.subscription_details)
    return true
  return typeof invoice.billing_reason === 'string' && invoice.billing_reason.startsWith('subscription')
}

// charge.failed fires for every charge, including credit auto top-ups and one-off
// purchases. Only a failed subscription invoice says anything about the plan.
// Errors propagate so the webhook is retried instead of guessing.
// One webhook checks the same charge twice (subscription check, backup retry): look it up once.
const chargeInvoiceLookups = new WeakMap<object, Promise<Stripe.Invoice | null>>()

// The invoice a charge paid (or tried to pay), through its PaymentIntent.
export function findInvoiceForCharge(stripe: Stripe, charge: Pick<Stripe.Charge, 'payment_intent'>) {
  let lookup = chargeInvoiceLookups.get(charge)
  if (!lookup) {
    lookup = lookupInvoiceForCharge(stripe, charge)
    chargeInvoiceLookups.set(charge, lookup)
    // Errors must not stick: a retried webhook delivery parses a new charge object anyway.
    lookup.catch(() => chargeInvoiceLookups.delete(charge))
  }
  return lookup
}

async function lookupInvoiceForCharge(stripe: Stripe, charge: Pick<Stripe.Charge, 'payment_intent'>) {
  const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id
  if (!paymentIntentId)
    return null
  const payments = await stripe.invoicePayments.list({
    payment: { type: 'payment_intent', payment_intent: paymentIntentId },
    limit: 1,
    expand: ['data.invoice'],
  })
  const invoice = payments.data[0]?.invoice
  if (!invoice || typeof invoice === 'string' || invoice.deleted)
    return null
  return invoice
}

export async function isSubscriptionCharge(stripe: Stripe, charge: Pick<Stripe.Charge, 'payment_intent'>) {
  // Legacy charges without a PaymentIntent keep the previous behavior.
  if (!charge.payment_intent)
    return true
  const invoice = await findInvoiceForCharge(stripe, charge)
  return !!invoice && isSubscriptionInvoice(invoice)
}

export function toOpenSubscriptionInvoiceSummary(invoice: OpenInvoiceShape): OpenSubscriptionInvoiceSummary {
  return {
    hosted_invoice_url: invoice.hosted_invoice_url ?? null,
    amount_due: invoice.amount_remaining ?? invoice.amount_due,
    currency: invoice.currency,
    attempt_count: invoice.attempt_count,
    next_payment_attempt: invoice.next_payment_attempt
      ? new Date(invoice.next_payment_attempt * 1000).toISOString()
      : null,
  }
}

export async function findLatestOpenSubscriptionInvoice(c: Context, customerId: string, billingAccount: BillingAccount = 'ee'): Promise<Stripe.Invoice | null> {
  // Stripe lists newest first; page past newer non-subscription invoices.
  for await (const invoice of getStripe(c, billingAccount).invoices.list({ customer: customerId, status: 'open', limit: 10 })) {
    if (isSubscriptionInvoice(invoice))
      return invoice
  }
  return null
}

// Best effort: dunning emails and the past-due banner still work without the pay link.
export async function getLatestOpenSubscriptionInvoice(c: Context, customerId: string, billingAccount: BillingAccount = 'ee'): Promise<OpenSubscriptionInvoiceSummary | null> {
  if (!isStripeConfiguredForAccount(c, billingAccount) || !customerId)
    return null
  try {
    const invoice = await findLatestOpenSubscriptionInvoice(c, customerId, billingAccount)
    return invoice ? toOpenSubscriptionInvoiceSummary(invoice) : null
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'getLatestOpenSubscriptionInvoice', customerId, billingAccount, error })
    return null
  }
}

async function getStoredPlanPriceId(c: Context, planId: string, recurrence: string, billingAccount: BillingAccount): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin(c)
      .from('plans')
      .select('price_m_id, price_y_id, price_m_id_us, price_y_id_us, stripe_id, stripe_id_us')
      .or(planProductIdOrFilter(planId))
      .single()

    if (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'getStoredPlanPriceId', planId, recurrence, error })
      return null
    }

    return getPlanPriceId(data, billingAccount, recurrence)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'getStoredPlanPriceId', planId, recurrence, error })
    return null
  }
}

async function getPriceIds(c: Context, planId: string, recurrence: string, billingAccount: BillingAccount): Promise<{ priceId: string | null }> {
  let priceId = null
  if (!isStripeConfiguredForAccount(c, billingAccount))
    return { priceId }
  // The plans table names the price Checkout sells: a replaced price stays active in Stripe until it is
  // archived after the release, so the Stripe listing alone could still pick it.
  priceId = await getStoredPlanPriceId(c, planId, recurrence, billingAccount)
  if (priceId)
    return { priceId }
  try {
    const prices = await listPricesByProduct(c, planId, billingAccount)
    cloudlog({ requestId: c.get('requestId'), message: 'prices stripe', prices })
    prices.data.forEach((price) => {
      if (price.recurring?.interval === recurrence && price.active && price.recurring?.usage_type === 'licensed')
        priceId = price.id
    })
  }
  catch (err) {
    cloudlog({ requestId: c.get('requestId'), message: 'search err', error: err })
  }
  cloudlog({ requestId: c.get('requestId'), message: 'prices fallback', planId, recurrence, priceId })
  return { priceId }
}

// Stripe sets unit_amount_decimal alone for sub-unit amounts.
function readStripeUnitAmount(source: { unit_amount?: number | null, unit_amount_decimal?: unknown }) {
  if (typeof source.unit_amount === 'number')
    return source.unit_amount
  if (source.unit_amount_decimal === null || source.unit_amount_decimal === undefined)
    return null
  const decimal = Number(String(source.unit_amount_decimal))
  return Number.isFinite(decimal) ? decimal : null
}

// Smallest-unit amount per currency, exactly as configured on the Stripe price (currency_options).
export function getPriceCurrencyAmounts(price: Pick<Stripe.Price, 'currency' | 'unit_amount' | 'unit_amount_decimal' | 'currency_options'>): Record<string, number> {
  const amounts: Record<string, number> = {}
  for (const [currency, option] of Object.entries(price.currency_options ?? {})) {
    const amount = readStripeUnitAmount(option)
    if (amount !== null)
      amounts[currency.toLowerCase()] = amount
  }
  const amount = readStripeUnitAmount(price)
  if (amount !== null)
    amounts[price.currency.toLowerCase()] = amount
  return amounts
}

// The price Checkout would sell for this plan, with every currency it is sold in.
export async function getCheckoutPlanPrice(c: Context, planProductId: string, recurrence: 'month' | 'year', billingAccount: BillingAccount): Promise<Stripe.Price | null> {
  const resolvedPlanId = await resolveCheckoutPlanProductId(c, planProductId, billingAccount)
  const { priceId } = await getPriceIds(c, resolvedPlanId, recurrence, billingAccount)
  if (!priceId)
    return null
  return await getStripe(c, billingAccount).prices.retrieve(priceId, { expand: ['currency_options'] })
}

// A customer is pinned to one currency once Stripe has billed them; null means any currency is allowed.
export async function getStripeCustomerCurrency(c: Context, customerId: string, billingAccount: BillingAccount): Promise<string | null> {
  const customer = await getStripe(c, billingAccount).customers.retrieve(customerId)
  if (customer.deleted)
    return null
  return customer.currency?.toLowerCase() ?? null
}

export interface MeteredData {
  [key: string]: string
}

export interface CreditCheckoutItemSummary {
  [key: string]: string | number | null
  id: string | null
  quantity: number | null
  priceId: string | null
  productId: string | null
}

export interface CreditCheckoutDetails {
  creditQuantity: number
  itemsSummary: CreditCheckoutItemSummary[]
}

export interface DatafastAttribution {
  visitorId?: string | null
  sessionId?: string | null
}

export type StripeWebhookStatus = Database['public']['Enums']['stripe_status'] | 'past_due'
export type StripeDataPayload = Omit<Database['public']['Tables']['stripe_info']['Insert'], 'status'> & {
  status?: StripeWebhookStatus | null
}

export interface StripeData {
  data: StripeDataPayload
  isUpgrade: boolean
  previousPriceId: string | undefined
  previousProductId: string | undefined
}

// Enterprise MAU slider: MAU above the plan allowance is a second item on the
// subscription, billed per 1,000 MAU with graduated tiers that mirror the MAU
// usage tiers. It raises the plan quota (stripe_info.extra_mau); it is not
// credits. Its prices are tagged so plan detection skips the item.
export const EXTRA_MAU_PRICE_KIND = 'extra_mau'
const EXTRA_MAU_LOOKUP_KEY_PREFIX = 'capgo_extra_mau_'
export const EXTRA_MAU_UNIT = 1_000
export const MAX_EXTRA_MAU = 1_000_000_000

interface TaggedPrice {
  lookup_key?: string | null
  metadata?: Stripe.Metadata | null
}

export function isExtraMauPrice(price: TaggedPrice | null | undefined) {
  if (!price)
    return false
  return price.metadata?.capgo_kind === EXTRA_MAU_PRICE_KIND
    || (price.lookup_key?.startsWith(EXTRA_MAU_LOOKUP_KEY_PREFIX) ?? false)
}

export function isExtraMauItem(item: Pick<Stripe.SubscriptionItem, 'price'>) {
  return isExtraMauPrice(item.price)
}

export function getExtraMau(items: Array<Pick<Stripe.SubscriptionItem, 'price' | 'quantity'>>) {
  return items.filter(isExtraMauItem).reduce((total, item) => total + (item.quantity ?? 0) * EXTRA_MAU_UNIT, 0)
}

interface MauTierStep {
  step_min: number
  step_max: number
  price_per_unit: number
}

// Graduated Stripe tiers for the MAU above `includedMau`, per 1,000 MAU, in cents.
export function buildExtraMauTiers(steps: MauTierStep[], includedMau: number, interval: 'month' | 'year') {
  const months = interval === 'year' ? 12 : 1
  const tiers: Stripe.PriceCreateParams.Tier[] = []
  for (const step of [...steps].sort((a, b) => a.step_min - b.step_min)) {
    if (step.step_max <= includedMau)
      continue
    // Current tiers are whole cents per 1,000 MAU ($0.60, $0.45, ...).
    const unitCents = Math.round(step.price_per_unit * EXTRA_MAU_UNIT * 100 * months)
    const isLast = step.step_max >= Number.MAX_SAFE_INTEGER
    tiers.push({
      up_to: isLast ? 'inf' : Math.ceil((step.step_max - includedMau) / EXTRA_MAU_UNIT),
      unit_amount: unitCents,
    })
  }
  if (tiers.length)
    tiers[tiers.length - 1].up_to = 'inf'
  return tiers
}

// USD-cent tiers re-priced with the plan's own ratio for that currency (local minor units per USD cent),
// so extra MAU follows the same per-currency pricing as the plan it is billed with.
export function scaleTiersToCurrency(tiers: Stripe.PriceCreateParams.Tier[], ratio: number): Stripe.PriceCreateParams.Tier[] {
  return tiers.map(({ unit_amount, ...tier }) => {
    const amount = Math.round((unit_amount ?? 0) * ratio * 10_000) / 10_000
    if (Number.isInteger(amount))
      return { ...tier, unit_amount: amount }
    // Plain string on purpose: the SDK form-encodes a Stripe.Decimal as its internal fields.
    return { ...tier, unit_amount_decimal: String(amount) as unknown as Stripe.Decimal }
  })
}

// Local minor units per USD cent for each currency of a plan price; empty without a USD amount.
export function getCurrencyRatios(amounts: Record<string, number>): Record<string, number> {
  const usd = amounts.usd
  if (!usd)
    return {}
  return Object.fromEntries(Object.entries(amounts).map(([currency, amount]) => [currency, amount / usd]))
}

// Short stable hash so a tier change gets a new price (lookup keys are unique).
function hashString(value: string) {
  let hash = 0x811C9DC5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

// Found by lookup key, created (with its product) on first use.
// `currencyRatios` (local minor units per USD cent, from the plan price) mirrors the plan's currency_options,
// so a non-USD checkout can bill both items in one currency at the plan's local pricing.
async function getExtraMauPriceId(c: Context, includedMau: number, interval: 'month' | 'year', taxBehavior: Stripe.Price.TaxBehavior | null, billingAccount: BillingAccount = 'ee', currencyRatios: Record<string, number> = {}) {
  const { data: steps, error } = await supabaseAdmin(c)
    .from('capgo_credits_steps')
    .select('step_min, step_max, price_per_unit')
    .eq('type', 'mau')
    .is('org_id', null)
  if (error || !steps?.length)
    throw simpleError('mau_tiers_not_found', 'Cannot load MAU price tiers', { error })

  const tiers = buildExtraMauTiers(steps, includedMau, interval)
  const currencies = Object.keys(currencyRatios).filter(currency => currency !== 'usd').sort((a, b) => a.localeCompare(b))
  const currencyTiers = Object.fromEntries(currencies.map(currency => [currency, scaleTiersToCurrency(tiers, currencyRatios[currency])]))
  const hashInput = currencies.length ? { includedMau, tiers, currencyTiers } : { includedMau, tiers }
  const lookupKey = `${EXTRA_MAU_LOOKUP_KEY_PREFIX}${interval}_${hashString(JSON.stringify(hashInput))}`
  const taxBehaviorParam = taxBehavior && taxBehavior !== 'unspecified' ? { tax_behavior: taxBehavior } : {}
  const existing = await getStripe(c, billingAccount).prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 })
  if (existing.data[0])
    return existing.data[0].id

  let created: Stripe.Price
  try {
    created = await getStripe(c, billingAccount).prices.create({
      currency: 'usd',
      billing_scheme: 'tiered',
      tiers_mode: 'graduated',
      tiers,
      recurring: { interval, usage_type: 'licensed' },
      product_data: {
        name: 'Enterprise extra MAU',
        unit_label: '1,000 MAU',
        metadata: { capgo_kind: EXTRA_MAU_PRICE_KIND },
      },
      lookup_key: lookupKey,
      nickname: `Enterprise extra MAU (${interval})`,
      metadata: { capgo_kind: EXTRA_MAU_PRICE_KIND, included_mau: String(includedMau) },
      ...taxBehaviorParam,
      ...(currencies.length
        ? { currency_options: Object.fromEntries(currencies.map(currency => [currency, { tiers: currencyTiers[currency], ...taxBehaviorParam }])) }
        : {}),
    })
  }
  catch (error) {
    // A concurrent first checkout may have created the same lookup key: reuse its price.
    const raced = await getStripe(c, billingAccount).prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 })
    if (raced.data[0])
      return raced.data[0].id
    throw error
  }
  cloudlog({ requestId: c.get('requestId'), message: 'created extra MAU price', priceId: created.id, lookupKey })
  return created.id
}

export function parsePriceIds(c: Context, prices: Stripe.SubscriptionItem[]): { priceId: string | null, productId: string | null } {
  let priceId: string | null = null
  let productId: string | null = null
  if (!isStripeConfigured(c))
    return { priceId, productId }
  try {
    cloudlog({ requestId: c.get('requestId'), message: 'prices stripe', prices })
    prices.forEach((price) => {
      if (price.plan.usage_type === 'licensed' && !isExtraMauItem(price)) {
        priceId = price.plan.id
        productId = price.plan.product as string
      }
    })
  }
  catch (err) {
    cloudlog({ requestId: c.get('requestId'), message: 'search err', error: err })
  }
  return { priceId, productId }
}

function getDatafastAttributionMetadata(attribution?: DatafastAttribution): Record<string, string> {
  return {
    ...(attribution?.visitorId ? { datafast_visitor_id: attribution.visitorId } : {}),
    ...(attribution?.sessionId ? { datafast_session_id: attribution.sessionId } : {}),
  }
}

function getAffonsoReferralMetadata(affonsoReferral?: string | null): Record<string, string> {
  // Affonso expects the referral cookie value on Stripe Checkout session metadata.
  // Stripe metadata values are capped at 500 characters; omit invalid/empty values.
  if (typeof affonsoReferral !== 'string' || !affonsoReferral || affonsoReferral.length > 500)
    return {}
  return { affonso_referral: affonsoReferral }
}

// Checkout only offers saved cards with allow_redisplay "always" by default. Cards added
// through the billing portal are "limited"/"unspecified", so customers were asked for a card again.
const CHECKOUT_SAVED_PAYMENT_METHOD_OPTIONS: Stripe.Checkout.SessionCreateParams.SavedPaymentMethodOptions = {
  allow_redisplay_filters: ['always', 'limited', 'unspecified'],
}

export interface ExtraMauCheckout {
  includedMau: number
  extraMau: number
}

// Embedded sessions render inside Capgo; url is only set for the hosted fallback.
export interface CheckoutSessionResult {
  url: string | null
  clientSecret?: string | null
  publishableKey?: string
  sessionId?: string
}

// The emulator only serves hosted pages, and Stripe.js needs the account's publishable key.
function getEmbeddedCheckoutPublishableKey(c: Context, billingAccount: BillingAccount, embedded?: boolean) {
  if (!embedded || isStripeEmulatorEnabled(c))
    return ''
  return getStripePublishableKey(c, billingAccount)
}

function getCheckoutRedirectParams(publishableKey: string, successUrl: string, cancelUrl: string): Pick<Stripe.Checkout.SessionCreateParams, 'ui_mode' | 'return_url' | 'redirect_on_completion' | 'success_url' | 'cancel_url'> {
  if (!publishableKey)
    return { success_url: successUrl, cancel_url: cancelUrl }
  // Cards complete in place; redirect-based methods come back to the same success URL.
  const separator = successUrl.includes('?') ? '&' : '?'
  return {
    ui_mode: 'embedded_page',
    redirect_on_completion: 'if_required',
    return_url: successUrl.includes('{CHECKOUT_SESSION_ID}') ? successUrl : `${successUrl}${separator}session_id={CHECKOUT_SESSION_ID}`,
  }
}

function toCheckoutSessionResult(session: Stripe.Checkout.Session, publishableKey: string): CheckoutSessionResult {
  if (!publishableKey)
    return { url: session.url }
  return { url: null, clientSecret: session.client_secret, publishableKey, sessionId: session.id }
}

// The server owns the currency: a billed customer keeps theirs even when the client sends none.
async function resolveCheckoutCurrency(c: Context, customerId: string, billingAccount: BillingAccount, planCurrencies: string[], requestedCurrency: string | undefined) {
  const customerCurrency = await getStripeCustomerCurrency(c, customerId, billingAccount)
  if (customerCurrency && requestedCurrency && customerCurrency !== requestedCurrency)
    throw simpleError('currency_locked', 'This organization is already billed in another currency', { currency: requestedCurrency, customerCurrency })
  const checkoutCurrency = customerCurrency ?? requestedCurrency
  if (checkoutCurrency && !planCurrencies.includes(checkoutCurrency))
    throw simpleError('invalid_currency', 'This plan is not sold in the requested currency', { currency: checkoutCurrency })
  return checkoutCurrency
}

export interface CheckoutOptions {
  clientReferenceId?: string
  attributionId?: string
  datafastAttribution?: DatafastAttribution
  affonsoReferral?: string | null
  extraMau?: ExtraMauCheckout
  // Embedded session rendered in Capgo instead of the hosted page.
  embedded?: boolean
  // Lowercase ISO currency; must be one of the plan price's Stripe currency_options.
  currency?: string
}

export async function createCheckout(c: Context, customerId: string, recurrence: string, planId: string, successUrl: string, cancelUrl: string, options: CheckoutOptions = {}): Promise<CheckoutSessionResult> {
  const { clientReferenceId, attributionId, datafastAttribution, affonsoReferral, extraMau, embedded } = options
  const requestedCurrency = options.currency?.trim().toLowerCase() || undefined
  const billingAccount = await getBillingAccountForCustomer(c, customerId)
  assertBillingAccountReachableForUser(c, billingAccount, customerId)
  if (!isStripeConfiguredForAccount(c, billingAccount))
    return { url: '' }
  const resolvedPlanId = await resolveCheckoutPlanProductId(c, planId, billingAccount)
  const prices = await getPriceIds(c, resolvedPlanId, recurrence, billingAccount)
  cloudlog({ requestId: c.get('requestId'), message: 'prices', prices, billingAccount, resolvedPlanId })
  if (!prices.priceId)
    return Promise.reject(new Error('Cannot find price'))
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [{ price: prices.priceId, quantity: 1 }]
  const planPrice = await getStripe(c, billingAccount).prices.retrieve(prices.priceId, { expand: ['currency_options'] })
  const planAmounts = getPriceCurrencyAmounts(planPrice)
  const planCurrencies = Object.keys(planAmounts)
  const checkoutCurrency = await resolveCheckoutCurrency(c, customerId, billingAccount, planCurrencies, requestedCurrency)
  if (extraMau && extraMau.extraMau > 0) {
    // Same interval as the plan: Checkout bills every item of a subscription together.
    const interval = recurrence === 'year' ? 'year' : 'month'
    const extraMauPriceId = await getExtraMauPriceId(c, extraMau.includedMau, interval, planPrice.tax_behavior ?? null, billingAccount, getCurrencyRatios(planAmounts))
    lineItems.push({ price: extraMauPriceId, quantity: extraMau.extraMau / EXTRA_MAU_UNIT })
  }
  const metadata = {
    ...(attributionId ? { attribution_id: attributionId } : {}),
    ...getDatafastAttributionMetadata(datafastAttribution),
    ...getAffonsoReferralMetadata(affonsoReferral),
  }
  const allowedSuccessUrl = getAllowedRedirectUrl(c, successUrl, 'success_url')
  const allowedCancelUrl = getAllowedRedirectUrl(c, cancelUrl, 'cancel_url')
  const publishableKey = getEmbeddedCheckoutPublishableKey(c, billingAccount, embedded)
  const session = await getStripe(c, billingAccount).checkout.sessions.create({
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    mode: 'subscription',
    customer: customerId,
    ...getCheckoutRedirectParams(publishableKey, `${allowedSuccessUrl}?success=true`, allowedCancelUrl),
    automatic_tax: { enabled: isAutomaticTaxEnabled(billingAccount) },
    client_reference_id: clientReferenceId,
    metadata: Object.keys(metadata).length ? metadata : undefined,
    customer_update: {
      address: 'auto',
      name: 'auto',
    },
    tax_id_collection: { enabled: true },
    saved_payment_method_options: CHECKOUT_SAVED_PAYMENT_METHOD_OPTIONS,
    line_items: lineItems,
    ...(checkoutCurrency ? { currency: checkoutCurrency } : {}),
  })
  return toCheckoutSessionResult(session, publishableKey)
}

async function listPricesByProduct(c: Context, productId: string, billingAccount: BillingAccount, active?: boolean) {
  return await getStripe(c, billingAccount).prices.list({
    product: productId,
    ...(active === undefined ? {} : { active }),
    limit: 100,
  })
}

export async function getOneTimePriceId(c: Context, productId: string, billingAccount: BillingAccount = 'ee'): Promise<string | null> {
  if (!isStripeConfiguredForAccount(c, billingAccount))
    return null
  try {
    const prices = await listPricesByProduct(c, productId, billingAccount, true)

    for (const price of prices.data) {
      if (price.type === 'one_time' && price.active)
        return price.id
    }
  }
  catch (err) {
    cloudlog({ requestId: c.get('requestId'), message: 'search one-time price error', error: err })
  }
  return null
}

export async function createOneTimeCheckout(
  c: Context,
  customerId: string,
  productId: string,
  quantity: number,
  successUrl: string,
  cancelUrl: string,
  clientReferenceId?: string,
  datafastAttribution?: DatafastAttribution,
  affonsoReferral?: string | null,
  embedded?: boolean,
): Promise<CheckoutSessionResult> {
  const billingAccount = await getBillingAccountForCustomer(c, customerId)
  assertBillingAccountReachableForUser(c, billingAccount, customerId)
  if (!isStripeConfiguredForAccount(c, billingAccount))
    return { url: '' }

  const priceId = await getOneTimePriceId(c, productId, billingAccount)
  if (!priceId)
    throw new Error(`Cannot find one-time price for product ${productId}`)

  const allowedSuccessUrl = getAllowedRedirectUrl(c, successUrl, 'success_url')
  const allowedCancelUrl = getAllowedRedirectUrl(c, cancelUrl, 'cancel_url')
  const successUrlWithFlag = allowedSuccessUrl.includes('?') ? `${allowedSuccessUrl}&success=true` : `${allowedSuccessUrl}?success=true`
  const publishableKey = getEmbeddedCheckoutPublishableKey(c, billingAccount, embedded)

  const session = await getStripe(c, billingAccount).checkout.sessions.create({
    billing_address_collection: 'auto',
    mode: 'payment',
    customer: customerId,
    ...getCheckoutRedirectParams(publishableKey, successUrlWithFlag, allowedCancelUrl),
    automatic_tax: { enabled: isAutomaticTaxEnabled(billingAccount) },
    client_reference_id: clientReferenceId,
    customer_update: {
      address: 'auto',
      name: 'auto',
    },
    tax_id_collection: { enabled: true },
    saved_payment_method_options: CHECKOUT_SAVED_PAYMENT_METHOD_OPTIONS,
    invoice_creation: { enabled: true },
    line_items: [
      {
        price: priceId,
        quantity,
        ...(isStripeEmulatorEnabled(c)
          ? {}
          : {
              adjustable_quantity: {
                enabled: true,
                minimum: 1,
                maximum: 100000,
              },
            }),
      },
    ],
    custom_text: {
      submit: {
        message: 'Your card may be saved so you can later enable optional credit auto top-up in organization settings.',
      },
    },
    payment_intent_data: {
      setup_future_usage: 'off_session',
    },
    metadata: {
      productId,
      orgId: clientReferenceId ?? '',
      intendedQuantity: String(quantity),
      ...getDatafastAttributionMetadata(datafastAttribution),
      ...getAffonsoReferralMetadata(affonsoReferral),
    },
  })
  return toCheckoutSessionResult(session, publishableKey)
}

export async function getCreditCheckoutDetails(c: Context, session: Stripe.Checkout.Session, expectedProductId: string, billingAccount: BillingAccount = 'ee'): Promise<CreditCheckoutDetails> {
  try {
    const lineItems = await getStripe(c, billingAccount).checkout.sessions.listLineItems(session.id, {
      expand: ['data.price.product'],
      limit: 100,
    })

    let creditQuantity = 0
    const itemsSummary = lineItems.data.map((item) => {
      const priceProduct = typeof item.price?.product === 'string'
        ? item.price.product
        : (item.price?.product as { id?: string } | null)?.id ?? null

      if (priceProduct === expectedProductId)
        creditQuantity += item.quantity ?? 0

      return {
        id: item.id ?? null,
        quantity: item.quantity ?? null,
        priceId: item.price?.id ?? null,
        productId: priceProduct,
      }
    })

    return {
      creditQuantity,
      itemsSummary,
    }
  }
  catch (error) {
    if (!isStripeEmulatorEnabled(c))
      throw error

    const metadataProductId = typeof session.metadata?.productId === 'string'
      ? session.metadata.productId
      : null
    const intendedQuantity = Number.parseInt(session.metadata?.intendedQuantity ?? '', 10)

    cloudlog({
      requestId: c.get('requestId'),
      message: 'Falling back to Stripe checkout metadata for credit checkout details',
      sessionId: session.id,
      expectedProductId,
      metadataProductId,
      error: error instanceof Error ? error.message : String(error),
    })

    if (metadataProductId === expectedProductId && Number.isFinite(intendedQuantity) && intendedQuantity > 0) {
      return {
        creditQuantity: intendedQuantity,
        itemsSummary: [
          {
            id: null,
            quantity: intendedQuantity,
            priceId: null,
            productId: metadataProductId,
          },
        ],
      }
    }

    return {
      creditQuantity: 0,
      itemsSummary: [],
    }
  }
}

function getAllowedRedirectUrl(c: Context, value: string, field: 'return_url' | 'success_url' | 'cancel_url') {
  const baseWebAppUrl = getEnv(c, 'WEBAPP_URL')
  if (!baseWebAppUrl)
    throw simpleError('invalid_redirect_url', 'WEBAPP_URL is not configured', { field })

  let baseUrl: URL
  let redirectUrl: URL
  try {
    baseUrl = new URL(baseWebAppUrl)
    redirectUrl = new URL(value, baseUrl)
  }
  catch {
    throw simpleError('invalid_redirect_url', `Invalid ${field}`, { field, value })
  }

  if (baseUrl.origin !== redirectUrl.origin)
    throw simpleError('invalid_redirect_url', `Invalid ${field}`, { field, value, expectedOrigin: baseUrl.origin })

  return redirectUrl.toString()
}

export interface StripeCustomer {
  id: string
  email: string
  name: string
  metadata: {
    user_id: string
    org_id?: string
    console?: string
    log_as?: string
  }
}

export function orgStripeCustomerIdempotencyKey(orgId: string) {
  return `org-customer:${orgId}`
}

export function localOrgStripeCustomerId(orgId: string) {
  return `cus_local_${orgId.replaceAll('-', '')}`
}

function isStripeIdempotencyMismatch(error: unknown) {
  if (!error || typeof error !== 'object')
    return false
  const candidate = error as { type?: string, rawType?: string, message?: string }
  const type = candidate.type ?? candidate.rawType
  if (type === 'idempotency_error' || type === 'StripeIdempotencyError')
    return true
  return typeof candidate.message === 'string' && candidate.message.toLowerCase().includes('idempotent')
}

function oldestCustomer(customers: Stripe.Customer[]) {
  return customers.toSorted((left, right) => left.created - right.created)[0] ?? null
}

function customerMatchesOrg(customer: Stripe.Customer, orgId: string) {
  return customer.metadata?.org_id === orgId
}

async function searchOrgStripeCustomer(c: Context, orgId: string, billingAccount: BillingAccount) {
  try {
    const result = await getStripe(c, billingAccount).customers.search({
      query: `metadata['org_id']:'${orgId.replaceAll('\'', '')}'`,
      limit: 10,
    })
    return oldestCustomer(result.data)
  }
  catch (error) {
    // Search is a separate Stripe service (unavailable in some regions, distinct rate limits).
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'searchOrgStripeCustomer failed',
      orgId,
      error,
    })
    return null
  }
}

async function findExistingOrgStripeCustomer(c: Context, orgId: string, email: string, billingAccount: BillingAccount) {
  const fromSearch = await searchOrgStripeCustomer(c, orgId, billingAccount)
  if (fromSearch)
    return fromSearch

  // Search is eventually consistent; list by email is a bounded read-after-write fallback.
  const listed = await getStripe(c, billingAccount).customers.list({ email, limit: 100 })
  const fromList = oldestCustomer(listed.data.filter(customer => customerMatchesOrg(customer, orgId)))
  if (fromList)
    return fromList

  // Email may have changed before Search indexed the original customer.
  return await searchOrgStripeCustomer(c, orgId, billingAccount)
}

export async function createCustomer(c: Context, email: string, userId: string, orgId: string, name: string, billingAccount: BillingAccount = 'ee') {
  cloudlog({ requestId: c.get('requestId'), message: 'createCustomer', email, userId, orgId, name, billingAccount })
  const baseConsoleUrl = trimTrailingSlashes(getEnv(c, 'WEBAPP_URL') || '')
  const metadata: Record<string, string> = {
    user_id: userId,
    org_id: orgId,
  }
  if (baseConsoleUrl) {
    metadata.log_as = `${baseConsoleUrl}/log-as/${userId}`
  }
  if (!isStripeConfiguredForAccount(c, billingAccount)) {
    cloudlog({ requestId: c.get('requestId'), message: 'createCustomer no stripe key', email, userId, name, billingAccount })
    return { id: localOrgStripeCustomerId(orgId), email, name, metadata }
  }
  // Org-create queue retries must return the same customer instead of minting duplicates.
  let customer: Stripe.Customer
  try {
    customer = await getStripe(c, billingAccount).customers.create({
      email,
      name,
      metadata,
    }, { idempotencyKey: orgStripeCustomerIdempotencyKey(orgId) })
  }
  catch (error) {
    if (!isStripeIdempotencyMismatch(error))
      throw error
    cloudlog({
      requestId: c.get('requestId'),
      message: 'createCustomer idempotency mismatch, searching existing customer',
      orgId,
    })
    const existing = await findExistingOrgStripeCustomer(c, orgId, email, billingAccount)
    if (!existing) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'createCustomer idempotency mismatch without existing customer',
        orgId,
        error,
      })
      throw error
    }
    customer = existing
  }
  // Add supabase dashboard link with the real customer ID after creation
  const supabaseLink = buildSupabaseDashboardLink(c, customer.id)
  if (supabaseLink) {
    metadata.supabase = supabaseLink
    await getStripe(c, billingAccount).customers.update(customer.id, { metadata })
  }
  return customer
}

export async function ensureCustomerMetadata(c: Context, customerId: string, orgId: string, userId?: string | null) {
  if (!customerId)
    return
  const billingAccount = await getBillingAccountForCustomer(c, customerId)
  if (!isStripeConfiguredForAccount(c, billingAccount))
    return

  const baseConsoleUrl = trimTrailingSlashes(getEnv(c, 'WEBAPP_URL') || '')
  const metadata: Record<string, string> = {
    org_id: orgId,
  }

  if (userId) {
    metadata.user_id = userId
    if (baseConsoleUrl)
      metadata.log_as = `${baseConsoleUrl}/log-as/${userId}`
  }

  const supabaseLink = buildSupabaseDashboardLink(c, customerId)
  if (supabaseLink)
    metadata.supabase = supabaseLink

  try {
    await getStripe(c, billingAccount).customers.update(customerId, { metadata })
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'ensureCustomerMetadata', error })
  }
}

export async function removeOldSubscription(c: Context, subscriptionId: string, billingAccount: BillingAccount = 'ee') {
  if (!isStripeConfiguredForAccount(c, billingAccount))
    return Promise.resolve()
  cloudlog({ requestId: c.get('requestId'), message: 'removeOldSubscription', id: subscriptionId, billingAccount })
  const deletedSubscription = await getStripe(c, billingAccount).subscriptions.cancel(subscriptionId)
  return deletedSubscription
}
