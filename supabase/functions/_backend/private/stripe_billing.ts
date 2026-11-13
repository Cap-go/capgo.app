import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Permission } from '../utils/rbac.ts'
import { Hono } from 'hono/tiny'
import { acceptCancelSaveOffer, declineCancelSaveOffer, parseOfferId, prepareCancelSaveOffer } from '../utils/cancel_save_offer.ts'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { cloudlogErr } from '../utils/logging.ts'
import { throwDatabaseLookupError } from '../utils/pg_auth_lookup.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { checkOrgAdminRole, checkPermission } from '../utils/rbac.ts'
import {
  getCustomerBillingProfile,
  isStripeBillingProfileTaxIdType,
  updateCustomerBillingProfile,
  type CustomerBillingProfileUpdate,
  type StripeTaxIdType,
} from '../utils/stripe_customer_billing_profile.ts'
import {
  createCardSetupIntent,
  getInAppBillingContext,
  getOpenInvoicePaymentSecret,
  getOpenInvoiceSummary,
  getSavedCards,
  getSubscriptionSummary,
  listInvoices,
  parseCancelComment,
  parseCancelFeedback,
  parsePaymentMethodRole,
  payOpenInvoice,
  removeBackupCard,
  resumeSubscription,
  savePaymentMethodFromIntent,
  scheduleSubscriptionCancel,
} from '../utils/stripe_in_app.ts'
import { cancelTrialPlan, getTrialPlanSummary, listSchedulableTrialPlans, scheduleTrialPlan, startTrialPlanNow } from '../utils/stripe_trial_plan.ts'
import { authPrincipal, queryJsonOne, withRlsContext } from '../utils/pg_rls.ts'

// In-app billing: replaces the Stripe billing portal and hosted invoice page.

interface OrgBody {
  orgId?: string
}

interface PaymentMethodBody extends OrgBody {
  intentId?: string
  role?: unknown
}

interface RemovePaymentMethodBody extends OrgBody {
  paymentMethodId?: string
}

interface TrialPlanBody extends OrgBody {
  affonsoReferral?: unknown
  datafastVisitorId?: unknown
  datafastSessionId?: unknown
  // Optional Stripe product id; when set, updates the onboarding plan before scheduling.
  productId?: unknown
}

interface CancelBody extends OrgBody {
  reason?: unknown
  comment?: unknown
  // The save offer shown before this cancel, recorded as declined.
  offerId?: unknown
}

interface CancelOfferBody extends OrgBody {
  reason?: unknown
  offerId?: unknown
}

type AppContext = Context<MiddlewareKeyVariables>

const ORG_ID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function assertOrgIdUuid(orgId: string) {
  if (!ORG_ID_UUID_RE.test(orgId))
    throw simpleError('invalid_body', 'Invalid orgId')
}

async function resolveBillingContext(c: AppContext, orgId: string | undefined, permission: Permission) {
  if (!orgId)
    throw simpleError('invalid_body', 'Missing orgId')
  const authorization = c.get('authorization')
  if (!authorization || !c.get('auth')?.userId)
    throw simpleError('not_authorized', 'Not authorized')

  // Authenticated client: RLS only returns orgs the caller belongs to.
  let org: { customer_id: string | null } | null = null
  try {
    org = await withRlsContext(c, authPrincipal(c), client => queryJsonOne<{ customer_id: string | null }>(
      client,
      'SELECT customer_id FROM public.orgs WHERE id = $1',
      [orgId],
    ))
  }
  catch {}
  if (!org)
    throw simpleError('not_authorized', 'Not authorized')
  if (!await checkPermission(c, permission, { orgId }))
    throw simpleError('not_authorized', 'Not authorized')
  if (!org.customer_id)
    throw simpleError('no_customer', 'No customer')

  return await getInAppBillingContext(c, org.customer_id)
}

async function resolveOrgAdminBillingProfile(c: AppContext, orgId: string | undefined) {
  if (!orgId)
    throw simpleError('invalid_body', 'Missing orgId')
  assertOrgIdUuid(orgId)
  const authorization = c.get('authorization')
  if (!authorization || !c.get('auth')?.userId)
    throw simpleError('not_authorized', 'Not authorized')

  let org: { customer_id: string | null } | null = null
  try {
    org = await withRlsContext(c, authPrincipal(c), client => queryJsonOne<{ customer_id: string | null }>(
      client,
      'SELECT customer_id FROM public.orgs WHERE id = $1',
      [orgId],
    ))
  }
  catch (error) {
    throwDatabaseLookupError(c, 'resolveOrgAdminBillingProfile.org', error, { orgId })
  }
  if (!org)
    throw simpleError('not_authorized', 'Not authorized')
  if (!await checkOrgAdminRole(c, orgId))
    throw simpleError('not_authorized', 'Not authorized')
  if (!org.customer_id)
    throw simpleError('no_customer', 'No customer')

  return await getInAppBillingContext(c, org.customer_id)
}

function parseBillingProfileUpdateBody(body: Record<string, unknown>): CustomerBillingProfileUpdate {
  const address = body.address
  if (!address || typeof address !== 'object')
    throw simpleError('invalid_address', 'Missing billing address')

  const line1 = typeof (address as { line1?: unknown }).line1 === 'string' ? (address as { line1: string }).line1 : null
  const country = typeof (address as { country?: unknown }).country === 'string' ? (address as { country: string }).country : null
  if (!line1 || !country)
    throw simpleError('invalid_address', 'Missing billing address')

  const readOptional = (key: 'line2' | 'city' | 'state' | 'postalCode') => {
    const value = (address as Record<string, unknown>)[key]
    if (value == null)
      return null
    if (typeof value !== 'string')
      throw simpleError('invalid_address', 'Invalid billing address')
    return value
  }

  let taxId: CustomerBillingProfileUpdate['taxId'] | undefined
  if ('taxId' in body) {
    if (body.taxId === null)
      taxId = null
    else if (body.taxId && typeof body.taxId === 'object') {
      const type = typeof (body.taxId as { type?: unknown }).type === 'string' ? (body.taxId as { type: string }).type : null
      const value = typeof (body.taxId as { value?: unknown }).value === 'string' ? (body.taxId as { value: string }).value : null
      if (!type || !value || !isStripeBillingProfileTaxIdType(type))
        throw simpleError('invalid_tax_id', 'Invalid tax ID')
      taxId = { type: type as StripeTaxIdType, value }
    }
    else {
      throw simpleError('invalid_tax_id', 'Invalid tax ID')
    }
  }

  return {
    address: {
      line1,
      country,
      line2: readOptional('line2'),
      city: readOptional('city'),
      state: readOptional('state'),
      postalCode: readOptional('postalCode'),
    },
    ...(taxId !== undefined ? { taxId } : {}),
  }
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('*', useCors)

app.post('/overview', middlewareAuth, async (c) => {
  const body = await parseBody<OrgBody>(c)
  const ctx = await resolveBillingContext(c, body.orgId, 'org.read_billing')
  const [{ card, backupCard }, subscription, invoices, openInvoice, trialPlan] = await Promise.all([
    getSavedCards(c, ctx),
    getSubscriptionSummary(c, ctx),
    listInvoices(ctx),
    getOpenInvoiceSummary(c, ctx),
    getTrialPlanSummary(c, ctx).catch((error) => {
      cloudlogErr({ requestId: c.get('requestId'), message: 'overview trial plan failed', orgId: body.orgId, error })
      return null
    }),
  ])
  return c.json({ publishableKey: ctx.publishableKey, card, backupCard, subscription, invoices, openInvoice, trialPlan })
})

// Trial card prompt: card on file and the onboarding plan that starts when the trial ends.
app.post('/trial-plan', middlewareAuth, async (c) => {
  const body = await parseBody<OrgBody>(c)
  const ctx = await resolveBillingContext(c, body.orgId, 'org.update_billing')
  const [cards, plan, plans] = await Promise.all([
    getSavedCards(c, ctx),
    getTrialPlanSummary(c, ctx),
    listSchedulableTrialPlans(c, ctx),
  ])
  return c.json({ card: cards.card, plan, plans })
})

function optionalString(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

app.post('/trial-plan/schedule', middlewareAuth, async (c) => {
  const body = await parseBody<TrialPlanBody>(c)
  const ctx = await resolveBillingContext(c, body.orgId, 'org.update_billing')
  const plan = await scheduleTrialPlan(c, ctx, body.orgId!, {
    affonsoReferral: optionalString(body.affonsoReferral),
    datafastVisitorId: optionalString(body.datafastVisitorId),
    datafastSessionId: optionalString(body.datafastSessionId),
  }, optionalString(body.productId))
  return c.json({ plan })
})

// Start the trial plan today and charge the saved card instead of waiting for the trial end.
app.post('/trial-plan/start-now', middlewareAuth, async (c) => {
  const body = await parseBody<TrialPlanBody>(c)
  const ctx = await resolveBillingContext(c, body.orgId, 'org.update_billing')
  return c.json(await startTrialPlanNow(c, ctx, body.orgId!, {
    affonsoReferral: optionalString(body.affonsoReferral),
    datafastVisitorId: optionalString(body.datafastVisitorId),
    datafastSessionId: optionalString(body.datafastSessionId),
  }, optionalString(body.productId)))
})

app.post('/trial-plan/cancel', middlewareAuth, async (c) => {
  const body = await parseBody<OrgBody>(c)
  const ctx = await resolveBillingContext(c, body.orgId, 'org.update_billing')
  return c.json({ plan: await cancelTrialPlan(c, ctx, body.orgId!) })
})

app.post('/setup-intent', middlewareAuth, async (c) => {
  const body = await parseBody<OrgBody>(c)
  const ctx = await resolveBillingContext(c, body.orgId, 'org.update_billing')
  return c.json(await createCardSetupIntent(ctx))
})

app.post('/payment-method', middlewareAuth, async (c) => {
  const body = await parseBody<PaymentMethodBody>(c)
  if (typeof body.intentId !== 'string')
    throw simpleError('invalid_intent_id', 'Missing intentId')
  const role = parsePaymentMethodRole(body.role)
  const ctx = await resolveBillingContext(c, body.orgId, 'org.update_billing')
  return c.json({ card: await savePaymentMethodFromIntent(c, ctx, body.intentId, role) })
})

app.post('/remove-backup-card', middlewareAuth, async (c) => {
  const body = await parseBody<RemovePaymentMethodBody>(c)
  if (typeof body.paymentMethodId !== 'string' || !/^pm_\w+$/.test(body.paymentMethodId))
    throw simpleError('invalid_payment_method', 'Missing paymentMethodId')
  const ctx = await resolveBillingContext(c, body.orgId, 'org.update_billing')
  return c.json(await removeBackupCard(c, ctx, body.paymentMethodId))
})

// Before canceling: the discount offered to stay, or null when not eligible.
app.post('/cancel-offer', middlewareAuth, async (c) => {
  const body = await parseBody<CancelOfferBody>(c)
  const feedback = parseCancelFeedback(body.reason)
  const ctx = await resolveBillingContext(c, body.orgId, 'org.update_billing')
  const offer = await prepareCancelSaveOffer(c, ctx, body.orgId!, feedback).catch((error) => {
    // The offer is optional: the customer can always cancel.
    cloudlogErr({ requestId: c.get('requestId'), message: 'cancel save offer failed', orgId: body.orgId, error })
    return null
  })
  return c.json({ offer })
})

app.post('/cancel-offer/accept', middlewareAuth, async (c) => {
  const body = await parseBody<CancelOfferBody>(c)
  const offerId = parseOfferId(body.offerId)
  if (!offerId)
    throw simpleError('invalid_offer_id', 'Missing offerId')
  const ctx = await resolveBillingContext(c, body.orgId, 'org.update_billing')
  const { discountEnd } = await acceptCancelSaveOffer(c, ctx, offerId)
  return c.json({ discountEnd, subscription: await getSubscriptionSummary(c, ctx) })
})

app.post('/cancel', middlewareAuth, async (c) => {
  const body = await parseBody<CancelBody>(c)
  const feedback = parseCancelFeedback(body.reason)
  const comment = parseCancelComment(body.comment)
  const offerId = parseOfferId(body.offerId)
  const ctx = await resolveBillingContext(c, body.orgId, 'org.update_billing')
  if (offerId)
    await declineCancelSaveOffer(c, ctx, offerId)
  return c.json({ subscription: await scheduleSubscriptionCancel(c, ctx, feedback, comment) })
})

app.post('/resume', middlewareAuth, async (c) => {
  const body = await parseBody<OrgBody>(c)
  const ctx = await resolveBillingContext(c, body.orgId, 'org.update_billing')
  return c.json({ subscription: await resumeSubscription(c, ctx) })
})

app.post('/pay-invoice', middlewareAuth, async (c) => {
  const body = await parseBody<OrgBody>(c)
  const ctx = await resolveBillingContext(c, body.orgId, 'org.update_billing')
  return c.json(await payOpenInvoice(c, ctx))
})

app.post('/invoice-payment-intent', middlewareAuth, async (c) => {
  const body = await parseBody<OrgBody>(c)
  const ctx = await resolveBillingContext(c, body.orgId, 'org.update_billing')
  const secret = await getOpenInvoicePaymentSecret(c, ctx)
  if (!secret)
    throw simpleError('no_open_invoice', 'No open invoice to pay')
  return c.json(secret)
})

app.get('/billing-profile', middlewareAuth, async (c) => {
  const orgId = c.req.query('orgId') ?? c.req.query('org_id')
  const ctx = await resolveOrgAdminBillingProfile(c, orgId)
  return c.json(await getCustomerBillingProfile(c, ctx))
})

app.post('/billing-profile', middlewareAuth, async (c) => {
  const body = await parseBody<Record<string, unknown>>(c)
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw simpleError('invalid_body', 'Invalid request body')
  const orgId = typeof body.orgId === 'string' ? body.orgId : undefined
  const ctx = await resolveOrgAdminBillingProfile(c, orgId)
  const update = parseBillingProfileUpdateBody(body)
  return c.json(await updateCustomerBillingProfile(c, ctx, update))
})
