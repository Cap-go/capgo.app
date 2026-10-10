import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { OpenSubscriptionInvoiceSummary } from '../utils/stripe.ts'
import { Hono } from 'hono/tiny'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'
import { cloudlogErr } from '../utils/logging.ts'
import { checkPermission } from '../utils/rbac.ts'
import { getLatestOpenSubscriptionInvoice } from '../utils/stripe.ts'
import { supabaseAdmin, supabaseWithAuth } from '../utils/supabase.ts'

interface PastDueBody {
  orgId: string
}

interface PastDueResponse {
  past_due: boolean
  invoice: OpenSubscriptionInvoiceSummary | null
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

// JWT for the dashboard banner, API key for the CLI warning.
app.post('/', middlewareAuth({ preferApiKey: true }), async (c) => {
  const body = await parseBody<PastDueBody>(c)
  if (!body?.orgId)
    throw simpleError('invalid_body', 'Missing orgId')

  const authContext = c.get('auth')
  if (!authContext?.userId)
    throw simpleError('not_authorized', 'Not authorized')

  // Authenticated client: RLS only returns orgs the caller belongs to.
  const { data: org, error: dbError } = await supabaseWithAuth(c, authContext)
    .from('orgs')
    .select('customer_id')
    .eq('id', body.orgId)
    .single()
  if (dbError || !org)
    throw simpleError('not_authorized', 'Not authorized')

  // Any org member may learn that billing is blocked (CLI keys are often
  // upload-only); the pay link and amount stay limited to billing managers.
  if (!await checkPermission(c, 'org.read', { orgId: body.orgId }))
    throw simpleError('not_authorized', 'Not authorized')
  const canManageBilling = await checkPermission(c, 'org.update_billing', { orgId: body.orgId })

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

  const response: PastDueResponse = { past_due: true, invoice: canManageBilling ? invoice : null }
  return c.json(response)
})
