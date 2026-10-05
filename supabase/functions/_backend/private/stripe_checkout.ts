import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlog } from '../utils/logging.ts'
import { checkPermission } from '../utils/rbac.ts'
import { createCheckout, EXTRA_MAU_UNIT, MAX_EXTRA_MAU } from '../utils/stripe.ts'
import { supabaseAdmin, supabaseClient } from '../utils/supabase.ts'
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
  // Enterprise MAU slider: MAU bought on top of the plan allowance.
  extraMau?: number
}

function parseExtraMau(value: unknown) {
  if (value === undefined || value === null || value === 0)
    return 0
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_EXTRA_MAU || value % EXTRA_MAU_UNIT !== 0)
    throw simpleError('invalid_extra_mau', `extraMau must be a multiple of ${EXTRA_MAU_UNIT} between 0 and ${MAX_EXTRA_MAU}`)
  return value
}

// Only Enterprise sells extra MAU.
async function getExtraMauCheckout(c: Parameters<typeof supabaseAdmin>[0], planId: string, extraMau: number) {
  if (extraMau <= 0)
    return undefined
  const { data: plan, error } = await supabaseAdmin(c)
    .from('plans')
    .select('name, mau')
    .eq('stripe_id', planId)
    .single()
  if (error || plan?.name !== 'Enterprise')
    throw simpleError('extra_mau_not_allowed', 'Extra MAU is only available on the Enterprise plan', { planId })
  return { includedMau: plan.mau, extraMau }
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

app.post('/', middlewareAuth, async (c) => {
  const body = await parseBody<CheckoutData>(c)
  cloudlog({ requestId: c.get('requestId'), message: 'post stripe checkout body', body })
  const extraMau = parseExtraMau(body.extraMau)

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
  const planId = body.priceId ?? 'price_1KkINoGH46eYKnWwwEi97h1B'
  const extraMauCheckout = await getExtraMauCheckout(c, planId, extraMau)
  const checkout = await createCheckout(c, org.customer_id, body.recurrence ?? 'month', planId, body.successUrl ?? `${getEnv(c, 'WEBAPP_URL')}/app/usage`, body.cancelUrl ?? `${getEnv(c, 'WEBAPP_URL')}/app/usage`, body.clientReferenceId, body.attributionId, {
    visitorId: body.datafastVisitorId,
    sessionId: body.datafastSessionId,
  }, body.affonsoReferral, extraMauCheckout)
  return c.json({ url: checkout.url })
})
