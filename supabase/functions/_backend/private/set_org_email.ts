import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { z } from 'zod'
import { Hono } from 'hono/tiny'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { BRES, parseBody, quickError, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'
import { checkPermission } from '../utils/rbac.ts'
import { updateCustomerEmail } from '../utils/stripe.ts'
import { supabaseAdmin, supabaseWithAuth } from '../utils/supabase.ts'

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
  const supabase = supabaseWithAuth(c, auth)

  const { data: organization, error: organizationError } = await supabase.from('orgs')
    .select('customer_id, management_email')
    .eq('id', safeBody.org_id)
    .maybeSingle()

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
  const { data: updatedOrg, error: updateOrgErr } = await supabaseAdmin(c).from('orgs')
    .update({ management_email: safeBody.email })
    .eq('id', safeBody.org_id)
    .select('id')
    .maybeSingle()

  if (updateOrgErr || !updatedOrg) {
    // revert stripe
    await updateCustomerEmail(c, organization.customer_id, organization.management_email)
    throw simpleError('critical_error', 'Critical error', { updateOrgErr, orgId: safeBody.org_id })
  }

  return c.json(BRES)
})
