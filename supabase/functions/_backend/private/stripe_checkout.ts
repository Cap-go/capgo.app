import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlog } from '../utils/logging.ts'
import { checkPermission } from '../utils/rbac.ts'
import { createCheckout } from '../utils/stripe.ts'
import { supabaseClient } from '../utils/supabase.ts'
import { getEnv } from '../utils/utils.ts'

interface CheckoutData {
  priceId: string
  clientReferenceId?: string
  recurrence: 'month' | 'year'
  attributionId?: string
  datafastVisitorId?: string
  datafastSessionId?: string
  affonsoReferral?: string
  successUrl: string
  cancelUrl: string
  orgId: string
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

app.post('/', middlewareAuth, async (c) => {
  const body = await parseBody<CheckoutData>(c)
  cloudlog({ requestId: c.get('requestId'), message: 'post stripe checkout body', body })

  if (!body.orgId)
    throw simpleError('no_org_id_provided', 'No org_id provided')

  const authorization = c.get('authorization')
  if (!authorization)
    throw simpleError('not_authorized', 'Not authorized')

  // Get user ID from auth context (already validated by middlewareAuth)
  const authContext = c.get('auth')
  if (!authContext?.userId)
    throw simpleError('not_authorized', 'Not authorized')

  // Use authenticated client - RLS will enforce access based on JWT
  const supabase = supabaseClient(c, authorization)

  cloudlog({ requestId: c.get('requestId'), message: 'auth', auth: authContext.userId })
  const { data: org, error: dbError } = await supabase
    .from('orgs')
    .select('customer_id')
    .eq('id', body.orgId)
    .single()
  if (dbError || !org)
    throw simpleError('not_authorized', 'Not authorized')
  if (!org.customer_id)
    throw simpleError('no_customer', 'No customer')

  if (!await checkPermission(c, 'org.update_billing', { orgId: body.orgId }))
    throw simpleError('not_authorize', 'Not authorize')

  cloudlog({ requestId: c.get('requestId'), message: 'user', org })
  const checkout = await createCheckout(c, org.customer_id, body.recurrence ?? 'month', body.priceId ?? 'price_1KkINoGH46eYKnWwwEi97h1B', body.successUrl ?? `${getEnv(c, 'WEBAPP_URL')}/app/usage`, body.cancelUrl ?? `${getEnv(c, 'WEBAPP_URL')}/app/usage`, body.clientReferenceId, body.attributionId, {
    visitorId: body.datafastVisitorId,
    sessionId: body.datafastSessionId,
  }, body.affonsoReferral)
  return c.json({ url: checkout.url })
})
