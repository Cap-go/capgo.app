import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Permission } from '../utils/rbac.ts'
import { Hono } from 'hono/tiny'
import { acceptCancelSaveOffer, declineCancelSaveOffer, parseOfferId, prepareCancelSaveOffer } from '../utils/cancel_save_offer.ts'
import { getInvoiceDocument } from '../utils/invoice_document.ts'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { cloudlogErr } from '../utils/logging.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { checkPermission } from '../utils/rbac.ts'
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
import { addBillingTaxId, getBillingProfile, removeBillingTaxId, updateBillingDetails } from '../utils/stripe_billing_profile.ts'
import { getBillingDiscounts } from '../utils/stripe_billing_discounts.ts'
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

// Profile is separate so a Stripe profile failure never hides cards or invoices.
app.post('/profile', middlewareAuth, async (c) => {
  const body = await parseBody<OrgBody>(c)
  const ctx = await resolveBillingContext(c, body.orgId, 'org.read_billing')
  return c.json(await getBillingProfile(ctx))
})

app.post('/profile/update', middlewareAuth, async (c) => {
  const body = await parseBody<OrgBody & { details?: unknown }>(c)
  const ctx = await resolveBillingContext(c, body.orgId, 'org.update_billing')
  return c.json(await updateBillingDetails(ctx, body.details))
})

app.post('/tax-id/add', middlewareAuth, async (c) => {
  const body = await parseBody<OrgBody & { taxId?: unknown }>(c)
  const ctx = await resolveBillingContext(c, body.orgId, 'org.update_billing')
  return c.json(await addBillingTaxId(ctx, body.taxId))
})

app.post('/tax-id/remove', middlewareAuth, async (c) => {
  const body = await parseBody<OrgBody & { taxIdId?: unknown }>(c)
  const ctx = await resolveBillingContext(c, body.orgId, 'org.update_billing')
  await removeBillingTaxId(ctx, body.taxIdId)
  return c.json({ status: 'ok' })
})

app.post('/discounts', middlewareAuth, async (c) => {
  const body = await parseBody<OrgBody>(c)
  const ctx = await resolveBillingContext(c, body.orgId, 'org.read_billing')
  return c.json(await getBillingDiscounts(c, ctx))
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

app.post('/invoice-document', middlewareAuth, async (c) => {
  const body = await parseBody<OrgBody & { invoiceId?: unknown }>(c)
  const ctx = await resolveBillingContext(c, body.orgId, 'org.read_invoices')
  if (!await checkPermission(c, 'org.read_billing', { orgId: body.orgId }))
    throw simpleError('not_authorized', 'Not authorized')
  c.header('Cache-Control', 'private, no-store')
  return c.json(await getInvoiceDocument(ctx, body.invoiceId))
})
