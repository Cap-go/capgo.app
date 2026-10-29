import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { OpenSubscriptionInvoiceSummary } from '../utils/stripe.ts'
import { Hono } from 'hono/tiny'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlogErr } from '../utils/logging.ts'
import { checkPermission } from '../utils/rbac.ts'
import { getLatestOpenSubscriptionInvoice } from '../utils/stripe.ts'
import { normalizeBillingAccount } from '../utils/stripe_billing.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { authPrincipal, queryJsonOne, withRlsContext } from '../utils/pg_rls.ts'

interface PastDueBody {
  orgId: string
}

interface PastDueResponse {
  past_due: boolean
  invoice: OpenSubscriptionInvoiceSummary | null
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

app.post('/', middlewareAuth, async (c) => {
  const body = await parseBody<PastDueBody>(c)
  if (!body?.orgId)
    throw simpleError('invalid_body', 'Missing orgId')

  const authorization = c.get('authorization')
  const authContext = c.get('auth')
  if (!authorization || !authContext?.userId)
    throw simpleError('not_authorized', 'Not authorized')

  // Authenticated client: RLS only returns orgs the caller belongs to.
  let org: { customer_id: string | null } | null = null
  try {
    org = await withRlsContext(c, authPrincipal(c), client => queryJsonOne<{ customer_id: string | null }>(
      client,
      'SELECT customer_id FROM public.orgs WHERE id = $1',
      [body.orgId],
    ))
  }
  catch {}
  if (!org)
    throw simpleError('not_authorized', 'Not authorized')

  if (!await checkPermission(c, 'org.update_billing', { orgId: body.orgId }))
    throw simpleError('not_authorized', 'Not authorized')

  const notPastDue: PastDueResponse = { past_due: false, invoice: null }
  if (!org.customer_id)
    return c.json(notPastDue)

  let stripeInfo: { status: string | null, past_due_at: string | null, billing_account: string | null } | null = null
  let stripeInfoError: unknown = null
  const pg = await getPgClient(c)
  try {
    stripeInfo = await queryJsonOne<{ status: string | null, past_due_at: string | null, billing_account: string | null }>(
      pg,
      'SELECT status, past_due_at, billing_account FROM public.stripe_info WHERE customer_id = $1',
      [org.customer_id],
    )
  }
  catch (error) {
    stripeInfoError = error
  }
  finally {
    closeClient(c, pg)
  }
  if (stripeInfoError) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'stripe_past_due stripe_info', orgId: body.orgId, error: stripeInfoError })
    throw simpleError('cannot_get_stripe_info', 'Cannot get billing status')
  }

  // Only hit Stripe when the stored state says a renewal payment failed.
  if (!stripeInfo?.past_due_at && stripeInfo?.status !== 'failed')
    return c.json(notPastDue)

  const invoice = await getLatestOpenSubscriptionInvoice(c, org.customer_id, normalizeBillingAccount(stripeInfo.billing_account))
  // A failed one-off charge (credits) leaves no open subscription invoice: not past due.
  if (!stripeInfo.past_due_at && !invoice)
    return c.json(notPastDue)

  const response: PastDueResponse = { past_due: true, invoice }
  return c.json(response)
})
