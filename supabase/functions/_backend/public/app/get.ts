import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { createSignedImageUrl } from '../../utils/storage.ts'
import { supabaseApikey } from '../../utils/supabase.ts'
import { fetchLimit, isValidAppId } from '../../utils/utils.ts'

export async function get(c: Context<MiddlewareKeyVariables>, appId: string, apikey: Database['public']['Tables']['apikeys']['Row']): Promise<Response> {
  if (!appId) {
    throw quickError(400, 'missing_app_id', 'Missing app_id')
  }
  if (!isValidAppId(appId)) {
    throw quickError(400, 'invalid_app_id', 'App ID must be a reverse domain string', { app_id: appId })
  }
  // Auth context is already set by middlewareKey
  if (!(await checkPermission(c, 'app.read', { appId }))) {
    throw quickError(401, 'cannot_access_app', 'You can\'t access this app', { app_id: appId })
  }

  const { data, error: dbError } = await supabaseApikey(c, apikey.key)
    .from('apps')
    .select('*')
    .eq('app_id', appId)
    .single()

  if (dbError || !data) {
    throw quickError(404, 'cannot_find_app', 'Cannot find app', { supabaseError: dbError })
  }

  if (data.icon_url) {
    const signedIcon = await createSignedImageUrl(c, data.icon_url)
    data.icon_url = signedIcon ?? ''
  }

  return c.json(data)
}

export async function getAll(c: Context, apikey: Database['public']['Tables']['apikeys']['Row'], page?: number, limit?: number, orgId?: string): Promise<Response> {
  // Default limit to 50 if not specified
  const itemsPerPage = limit ?? fetchLimit
  const currentPage = page ?? 0
  const offset = currentPage * itemsPerPage

  let query = supabaseApikey(c, apikey.key)
    .from('apps')
    .select('*')

  // If a specific org_id is provided, filter by it
  if (orgId) {
    if (!(await checkPermission(c, 'org.read', { orgId }))) {
      throw simpleError('user_does_not_have_access_to_this_organization', 'You do not have access to this organization', { org_id: orgId })
    }

    query = query.eq('owner_org', orgId)
  }
  else {
    // Get list of orgs this key can read via RPC (avoids direct org_users select).
    const { data: userOrgs, error: orgsError } = await supabaseApikey(c, apikey.key)
      .rpc('get_orgs_v6')

    if (orgsError) {
      throw simpleError('cannot_get_user_organizations', 'Cannot get user organizations', { supabaseError: orgsError })
    }

    if (userOrgs && userOrgs.length > 0) {
      const orgIds = userOrgs.map(org => org.gid)
      query = query.in('owner_org', orgIds)
    }
  }

  // Apply pagination after filtering
  query = query.range(offset, offset + itemsPerPage - 1)

  const { data, error: dbError } = await query

  if (dbError) {
    throw simpleError('cannot_get_apps', 'Cannot get apps', { supabaseError: dbError })
  }

  const signedApps = await Promise.all(
    (data ?? []).map(async (app) => {
      if (!app.icon_url)
        return app
      const signedIcon = await createSignedImageUrl(c, app.icon_url)
      return {
        ...app,
        icon_url: signedIcon ?? '',
      }
    }),
  )

  return c.json(signedApps)
}
