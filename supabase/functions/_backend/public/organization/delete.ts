import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { BRES, quickError, simpleError } from '../../utils/hono.ts'
import { apikeyPrincipal, queryJson, withRlsContext } from '../../utils/pg_rls.ts'
import { checkPermission } from '../../utils/rbac.ts'

interface DeleteOrganizationParams {
  orgId?: string
}

export async function deleteOrg(c: Context<MiddlewareKeyVariables>, body: DeleteOrganizationParams, apikey: Database['public']['Tables']['apikeys']['Row']): Promise<Response> {
  const orgId = body.orgId

  if (!orgId) {
    throw simpleError('missing_org_id', 'Missing orgId')
  }

  // Check if user has right to delete the organization (requires super_admin equivalent)
  // Auth context is already set by middlewareKey
  if (!(await checkPermission(c, 'org.delete', { orgId }))) {
    throw quickError(403, 'invalid_org_id', 'You can\'t delete this organization', { org_id: orgId })
  }

  const principal = apikeyPrincipal(c, apikey.key)
  let deletedOrg: { id: string } | null = null
  try {
    const deletedOrgs = await withRlsContext(c, principal, client => queryJson<{ id: string }>(
      client,
      'DELETE FROM public.orgs WHERE id = $1 RETURNING id',
      [orgId],
    ))
    deletedOrg = deletedOrgs[0] ?? null
  }
  catch (error) {
    throw simpleError('cannot_delete_organization', 'Cannot delete organization', { error })
  }

  if (!deletedOrg) {
    throw quickError(403, 'invalid_org_id', 'You can\'t delete this organization', { org_id: orgId })
  }

  return c.json(BRES)
}
