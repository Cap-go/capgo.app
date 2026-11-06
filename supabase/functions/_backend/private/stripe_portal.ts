import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { PortalFlow } from '../utils/stripe.ts'
import { Hono } from 'hono/tiny'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlog } from '../utils/logging.ts'
import { checkPermission } from '../utils/rbac.ts'
import { createPortal } from '../utils/stripe.ts'
import { authPrincipal, queryJsonOne, withRlsContext } from '../utils/pg_rls.ts'

interface PortalData {
  callbackUrl: string
  orgId: string
  flow?: PortalFlow
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

app.post('/', middlewareAuth, async (c) => {
  const body = await parseBody<PortalData>(c)
  cloudlog({ requestId: c.get('requestId'), message: 'post stripe portal body', body })
  const authorization = c.get('authorization')
  if (!authorization)
    throw simpleError('not_authorized', 'Not authorized')

  // Get current user ID from JWT
  const authContext = c.get('auth')
  if (!authContext?.userId)
    throw simpleError('not_authorized', 'Not authorized')

  cloudlog({ requestId: c.get('requestId'), message: 'auth', auth: authContext.userId })
  // Authenticated context - RLS will enforce access based on JWT
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
  if (!org.customer_id)
    throw simpleError('no_customer', 'No customer')

  if (!await checkPermission(c, 'org.update_billing', { orgId: body.orgId }))
    throw simpleError('not_authorize', 'Not authorize')

  cloudlog({ requestId: c.get('requestId'), message: 'org', org })
  const flow = body.flow === 'cancel_subscription' ? body.flow : undefined
  const link = await createPortal(c, org.customer_id, body.callbackUrl, flow)
  return c.json({ url: link.url })
})
