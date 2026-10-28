import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { z } from 'zod'
import { Hono } from 'hono/tiny'
import { syncBillingBentoTagsFromStoredStripeInfo } from '../triggers/stripe_event.ts'
import { BRES, parseBody, quickError, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'
import { checkPermission } from '../utils/rbac.ts'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { updateCustomerEmail } from '../utils/stripe.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { authPrincipal, queryJsonOne, withRlsContext } from '../utils/pg_rls.ts'

const bodySchema = z.object({
  email: z.email(),
  org_id: z.uuid(),
})

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

app.post('/', middlewareAuth(), async (c) => {
  const auth = c.get('auth')!

  const body = await parseBody<any>(c)
  const parsedBodyResult = safeParseSchema(bodySchema, body)
  if (!parsedBodyResult.success) {
    throw simpleError('invalid_json_body', 'Invalid json body', { body, parsedBodyResult })
  }

  const safeBody = parsedBodyResult.data

  // Use authenticated client for data queries - RLS will enforce access
  let organization: { customer_id: string | null, management_email: string, created_by: string, name: string } | null = null
  let organizationError: unknown = null
  try {
    organization = await withRlsContext(c, authPrincipal(c, auth), client => queryJsonOne<{ customer_id: string | null, management_email: string, created_by: string, name: string }>(
      client,
      'SELECT customer_id, management_email, created_by, name FROM public.orgs WHERE id = $1',
      [safeBody.org_id],
    ))
  }
  catch (error) {
    organizationError = error
  }

  if (organizationError) {
    return quickError(500, 'internal_error', 'Failed to fetch organization', { orgId: safeBody.org_id, organizationError })
  }

  if (!organization) {
    throw simpleError('org_not_found', 'Organization not found', { orgId: safeBody.org_id })
  }

  if (!organization.customer_id) {
    throw simpleError('org_does_not_have_customer', 'Organization does not have a customer id', { orgId: safeBody.org_id })
  }

  if (!(await checkPermission(c, 'org.update_billing', { orgId: safeBody.org_id }))) {
    return quickError(401, 'not_authorized', 'Not authorized', { userId: auth.userId, orgId: safeBody.org_id })
  }

  await updateCustomerEmail(c, organization.customer_id, safeBody.email)

  // Update supabase
  let updatedOrg: { id: string } | undefined
  let updateOrgErr: unknown = null
  const pg = await getPgClient(c)
  try {
    const result = await pg.query<{ id: string }>('UPDATE public.orgs SET management_email = $1 WHERE id = $2 RETURNING id', [safeBody.email, safeBody.org_id])
    updatedOrg = result.rows[0]
  }
  catch (error) {
    updateOrgErr = error
  }
  finally {
    closeClient(c, pg)
  }

  if (updateOrgErr || !updatedOrg) {
    // revert stripe
    await updateCustomerEmail(c, organization.customer_id, organization.management_email)
    throw simpleError('critical_error', 'Critical error', { updateOrgErr, orgId: safeBody.org_id })
  }

  await syncBillingBentoTagsFromStoredStripeInfo(c, {
    id: safeBody.org_id,
    name: organization.name,
    management_email: safeBody.email,
    created_by: organization.created_by,
    customer_id: organization.customer_id,
  }, organization.customer_id)

  return c.json(BRES)
})
