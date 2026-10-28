import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { apikeyPrincipal, queryJson, queryJsonOne, withRlsContext } from '../../utils/pg_rls.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { createSignedImageUrl } from '../../utils/storage.ts'
import { fetchLimit, isValidAppId } from '../../utils/utils.ts'

type AppRow = Database['public']['Tables']['apps']['Row']

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

  let data: AppRow | null = null
  let dbError: unknown = null
  try {
    data = await withRlsContext(c, apikeyPrincipal(c, apikey.key), client => queryJsonOne<AppRow>(
      client,
      'SELECT * FROM public.apps WHERE app_id = $1',
      [appId],
    ))
  }
  catch (error) {
    dbError = error
  }

  if (dbError || !data) {
    throw quickError(404, 'cannot_find_app', 'Cannot find app', { supabaseError: dbError })
  }

  if (data.icon_url) {
    const signedIcon = await createSignedImageUrl(c, data.icon_url, {
      orgId: data.owner_org,
      appId: data.app_id,
    })
    data.icon_url = signedIcon ?? ''
  }

  return c.json(data)
}

export async function getAll(c: Context, apikey: Database['public']['Tables']['apikeys']['Row'], page?: number, limit?: number, orgId?: string): Promise<Response> {
  // Default limit to 50 if not specified
  const itemsPerPage = limit ?? fetchLimit
  const currentPage = page ?? 0
  const offset = currentPage * itemsPerPage

  // If a specific org_id is provided, filter by it
  if (orgId) {
    if (!(await checkPermission(c, 'org.read', { orgId }))) {
      throw simpleError('user_does_not_have_access_to_this_organization', 'You do not have access to this organization', { org_id: orgId })
    }
  }

  const data = await withRlsContext(c, apikeyPrincipal(c, apikey.key), async (client) => {
    let orgIds: string[] | null = orgId ? [orgId] : null
    if (!orgId) {
      // Get list of orgs this key can read via RPC (avoids direct org_users select).
      try {
        const { rows: userOrgs } = await client.query<{ gid: string }>('SELECT gid FROM public.get_orgs_v6()')
        if (userOrgs.length > 0)
          orgIds = userOrgs.map(org => org.gid)
      }
      catch (orgsError) {
        throw simpleError('cannot_get_user_organizations', 'Cannot get user organizations', { supabaseError: orgsError })
      }
    }

    // Apply pagination after filtering; LEAST keeps the PostgREST max_rows cap.
    try {
      return await queryJson<AppRow>(
        client,
        `SELECT * FROM public.apps
         WHERE ($1::uuid[] IS NULL OR owner_org = ANY($1::uuid[]))
         LIMIT LEAST($2::bigint, 1000) OFFSET $3::bigint`,
        [orgIds, itemsPerPage, offset],
      )
    }
    catch (dbError) {
      throw simpleError('cannot_get_apps', 'Cannot get apps', { supabaseError: dbError })
    }
  })

  const signedApps = await Promise.all(
    data.map(async (app) => {
      if (!app.icon_url)
        return app
      const signedIcon = await createSignedImageUrl(c, app.icon_url, {
        orgId: app.owner_org,
        appId: app.app_id,
      })
      return {
        ...app,
        icon_url: signedIcon ?? '',
      }
    }),
  )

  return c.json(signedApps)
}
