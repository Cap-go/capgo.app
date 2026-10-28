import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Permission } from '../utils/rbac.ts'
import { Hono } from 'hono/tiny'
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

app.post('/cancel', middlewareAuth, async (c) => {
  const body = await parseBody<CancelBody>(c)
  const feedback = parseCancelFeedback(body.reason)
  const comment = parseCancelComment(body.comment)
  const ctx = await resolveBillingContext(c, body.orgId, 'org.update_billing')
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
