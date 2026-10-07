import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { OpenSubscriptionInvoiceSummary } from '../utils/stripe.ts'
import { Hono } from 'hono/tiny'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlogErr } from '../utils/logging.ts'
import { checkPermission } from '../utils/rbac.ts'
import { getLatestOpenSubscriptionInvoice } from '../utils/stripe.ts'
import { supabaseAdmin, supabaseClient } from '../utils/supabase.ts'

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
  const { data: org, error: dbError } = await supabaseClient(c, authorization)
    .from('orgs')
    .select('customer_id')
    .eq('id', body.orgId)
    .single()
  if (dbError || !org)
    throw simpleError('not_authorized', 'Not authorized')

  if (!await checkPermission(c, 'org.update_billing', { orgId: body.orgId }))
    throw simpleError('not_authorized', 'Not authorized')

  const notPastDue: PastDueResponse = { past_due: false, invoice: null }
  if (!org.customer_id)
    return c.json(notPastDue)

  const { data: stripeInfo, error: stripeInfoError } = await supabaseAdmin(c)
    .from('stripe_info')
    .select('status, past_due_at')
    .eq('customer_id', org.customer_id)
    .maybeSingle()
  if (stripeInfoError) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'stripe_past_due stripe_info', orgId: body.orgId, error: stripeInfoError })
    throw simpleError('cannot_get_stripe_info', 'Cannot get billing status')
  }

  // Only hit Stripe when the stored state says a renewal payment failed.
  if (!stripeInfo?.past_due_at && stripeInfo?.status !== 'failed')
    return c.json(notPastDue)

  const invoice = await getLatestOpenSubscriptionInvoice(c, org.customer_id)
  // A failed one-off charge (credits) leaves no open subscription invoice: not past due.
  if (!stripeInfo.past_due_at && !invoice)
    return c.json(notPastDue)

  const response: PastDueResponse = { past_due: true, invoice }
  return c.json(response)
})
