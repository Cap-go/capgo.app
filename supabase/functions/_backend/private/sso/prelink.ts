import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import { z } from 'zod'
import { safeParseSchema } from '../../utils/schema_validation.ts'
import { createHono, parseBody, quickError, simpleError, useCors } from '../../utils/hono.ts'
import { middlewareAuth } from '../../utils/hono_jwt.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { authPrincipal, queryJsonOne, withRlsContext } from '../../utils/pg_rls.ts'
import { version } from '../../utils/version.ts'
import { runPrelinkUsers } from './prelink-shared.ts'

const bodySchema = z.object({
  provider_id: z.uuid(),
})

export const app = createHono('', version)

app.use('*', useCors)
app.use('*', middlewareAuth)

app.post('/', async (c: Context<MiddlewareKeyVariables>) => {
  const auth = c.get('auth')
  if (!auth) {
    return quickError(401, 'not_authorized', 'Not authorized')
  }

  const rawBody = await parseBody<{ provider_id?: string }>(c)
  const validation = safeParseSchema(bodySchema, rawBody)
  if (!validation.success) {
    throw simpleError('invalid_body', 'Invalid request body', { errors: validation.error.message })
  }

  const { provider_id } = validation.data

  if (!auth.jwt) {
    return quickError(401, 'not_authorized', 'No JWT token found')
  }

  // Use authenticated client for DB read (RLS-enforced)
  let provider: { id: string, org_id: string, domain: string, provider_id: string | null, status: string } | null = null
  try {
    provider = await withRlsContext(c, authPrincipal(c, auth), client => queryJsonOne<{ id: string, org_id: string, domain: string, provider_id: string | null, status: string }>(
      client,
      'SELECT id, org_id, domain, provider_id, status FROM public.sso_providers WHERE id = $1',
      [provider_id],
    ))
  }
  catch {}

  if (!provider) {
    return quickError(404, 'provider_not_found', 'SSO provider not found')
  }

  // Validate permission for this org
  const allowed = await checkPermission(c, 'org.update_settings' as any, { orgId: provider.org_id })
  if (!allowed) {
    return quickError(403, 'not_authorized', 'Not authorized to manage SSO for this organization')
  }

  return c.json(await runPrelinkUsers(c, {
    provider_id,
    org_id: provider.org_id,
    domain: provider.domain,
  }))
})
