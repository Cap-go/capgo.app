import type { Context } from 'hono'
import type Stripe from 'stripe'
import { stripeAmountToMajorUnits } from '../../shared/stripe-amount.ts'
import { AFFONSO_API_URL, postBearerJson } from './affonso.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { getStripe } from './stripe.ts'
import { getStripeCustomerId } from './stripe_event.ts'
import { getEnv } from './utils.ts'

// Affonso and DataFast connect natively to one Stripe account only (EE).
// US account payments are pushed to their server-side APIs instead.

const DATAFAST_API_URL = 'https://datafa.st/api/v1/payments'
const MAX_CHECKOUT_SESSIONS_SCANNED = 20
const AFFONSO_CONVERSION_METADATA_KEY = 'affonso_conversion_id'

interface RevenueAttribution {
  affonsoReferral: string | null
  datafastVisitorId: string | null
}

function metadataValue(metadata: Stripe.Metadata | null | undefined, key: string): string | null {
  const value = metadata?.[key]
  return typeof value === 'string' && value ? value : null
}

function attributionFromMetadata(metadata: Stripe.Metadata | null | undefined): RevenueAttribution {
  return {
    affonsoReferral: metadataValue(metadata, 'affonso_referral'),
    datafastVisitorId: metadataValue(metadata, 'datafast_visitor_id'),
  }
}

function hasAttribution(attribution: RevenueAttribution) {
  return Boolean(attribution.affonsoReferral || attribution.datafastVisitorId)
}

// Checkout metadata lives on the session only. Copy it to the customer on first
// use so renewals and auto top-ups keep crediting the same referral/visitor.
async function resolveCustomerAttribution(c: Context, customerId: string): Promise<RevenueAttribution> {
  const stripe = getStripe(c, 'us')
  const customer = await stripe.customers.retrieve(customerId)
  if (customer.deleted)
    return { affonsoReferral: null, datafastVisitorId: null }
  const stored = attributionFromMetadata(customer.metadata)
  if (hasAttribution(stored))
    return stored

  const sessions = await stripe.checkout.sessions.list({ customer: customerId, status: 'complete', limit: MAX_CHECKOUT_SESSIONS_SCANNED })
  const session = sessions.data.find(s => hasAttribution(attributionFromMetadata(s.metadata)))
  if (!session)
    return stored
  const attribution = attributionFromMetadata(session.metadata)
  await stripe.customers.update(customerId, {
    metadata: {
      ...(attribution.affonsoReferral ? { affonso_referral: attribution.affonsoReferral } : {}),
      ...(attribution.datafastVisitorId ? { datafast_visitor_id: attribution.datafastVisitorId } : {}),
    },
  })
  return attribution
}

function buildAffonsoConversion(charge: Stripe.Charge, referralId: string) {
  return {
    referral_id: referralId,
    customer_id: getStripeCustomerId(charge.customer) || undefined,
    sale_amount: stripeAmountToMajorUnits(charge.amount, charge.currency),
    sale_amount_currency: charge.currency.toUpperCase(),
    external_event_id: charge.id,
    created_at: new Date(charge.created * 1000).toISOString(),
    metadata: { stripe_account: 'us' },
  }
}

function buildDatafastPayment(charge: Stripe.Charge, visitorId: string | null) {
  return {
    amount: stripeAmountToMajorUnits(charge.amount, charge.currency),
    currency: charge.currency.toUpperCase(),
    transaction_id: charge.id,
    customer_id: getStripeCustomerId(charge.customer) || undefined,
    ...(visitorId ? { datafast_visitor_id: visitorId } : {}),
    ...(charge.billing_details?.email ? { email: charge.billing_details.email } : {}),
    timestamp: new Date(charge.created * 1000).toISOString(),
  }
}

function buildDatafastRefund(charge: Stripe.Charge, refund: Stripe.Refund) {
  return {
    amount: stripeAmountToMajorUnits(refund.amount, refund.currency),
    currency: refund.currency.toUpperCase(),
    transaction_id: charge.id,
    customer_id: getStripeCustomerId(charge.customer) || undefined,
    refunded: true,
    timestamp: new Date(refund.created * 1000).toISOString(),
  }
}

async function trackAffonsoSale(c: Context, charge: Stripe.Charge, referralId: string) {
  const apiKey = getEnv(c, 'AFFONSO_API_KEY')
  if (!apiKey)
    return
  const result = await postBearerJson(`${AFFONSO_API_URL}/conversions`, apiKey, buildAffonsoConversion(charge, referralId))
  const conversionId = typeof result?.data?.id === 'string' ? result.data.id : null
  if (conversionId && charge.metadata?.[AFFONSO_CONVERSION_METADATA_KEY] !== conversionId) {
    // Kept on the charge so a later refund can find the Affonso conversion.
    await getStripe(c, 'us').charges.update(charge.id, { metadata: { [AFFONSO_CONVERSION_METADATA_KEY]: conversionId } })
  }
  cloudlog({ requestId: c.get('requestId'), message: 'Affonso US conversion tracked', chargeId: charge.id, conversionId })
}

async function trackDatafastSale(c: Context, charge: Stripe.Charge, visitorId: string | null) {
  const apiKey = getEnv(c, 'DATAFAST_API_KEY')
  if (!apiKey)
    return
  await postBearerJson(DATAFAST_API_URL, apiKey, buildDatafastPayment(charge, visitorId))
  cloudlog({ requestId: c.get('requestId'), message: 'DataFast US payment tracked', chargeId: charge.id })
}

async function runTracker(c: Context, name: string, chargeId: string, task: () => Promise<void>) {
  try {
    await task()
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: `${name} US revenue tracking failed`, chargeId, error })
  }
}

export async function trackUsChargeSucceeded(c: Context, charge: Stripe.Charge) {
  const customerId = getStripeCustomerId(charge.customer)
  if (!charge.paid || charge.amount <= 0)
    return
  const attribution = customerId
    ? await resolveCustomerAttribution(c, customerId).catch((error) => {
        cloudlogErr({ requestId: c.get('requestId'), message: 'US revenue attribution lookup failed', chargeId: charge.id, error })
        return { affonsoReferral: null, datafastVisitorId: null } satisfies RevenueAttribution
      })
    : attributionFromMetadata(charge.metadata)

  await Promise.all([
    attribution.affonsoReferral
      ? runTracker(c, 'Affonso', charge.id, () => trackAffonsoSale(c, charge, attribution.affonsoReferral!))
      : Promise.resolve(),
    runTracker(c, 'DataFast', charge.id, () => trackDatafastSale(c, charge, attribution.datafastVisitorId)),
  ])
}

export async function trackUsChargeRefunded(c: Context, charge: Stripe.Charge) {
  const refunds = await getStripe(c, 'us').refunds.list({ charge: charge.id, limit: 100 }).catch((error) => {
    cloudlogErr({ requestId: c.get('requestId'), message: 'US refund lookup failed', chargeId: charge.id, error })
    return null
  })
  if (!refunds)
    return
  const succeeded = refunds.data.filter(refund => refund.status === 'succeeded')
  if (succeeded.length === 0)
    return

  const affonsoKey = getEnv(c, 'AFFONSO_API_KEY')
  const conversionId = metadataValue(charge.metadata, AFFONSO_CONVERSION_METADATA_KEY)
  const datafastKey = getEnv(c, 'DATAFAST_API_KEY')

  for (const refund of succeeded) {
    await Promise.all([
      affonsoKey && conversionId
        ? runTracker(c, 'Affonso', charge.id, async () => {
            await postBearerJson(`${AFFONSO_API_URL}/conversions/${encodeURIComponent(conversionId)}/refund`, affonsoKey, {
              amount: stripeAmountToMajorUnits(refund.amount, refund.currency),
              currency: refund.currency.toUpperCase(),
              reason: refund.reason ?? undefined,
              external_event_id: refund.id,
              refunded_at: new Date(refund.created * 1000).toISOString(),
            })
          })
        : Promise.resolve(),
      datafastKey
        ? runTracker(c, 'DataFast', charge.id, async () => {
            await postBearerJson(DATAFAST_API_URL, datafastKey, buildDatafastRefund(charge, refund))
          })
        : Promise.resolve(),
    ])
  }
}
