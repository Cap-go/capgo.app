import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseApikey } from '../../utils/supabase.ts'
import { fetchLimit, isValidAppId } from '../../utils/utils.ts'

export interface GetLatest {
  app_id: string
  version?: string
  page?: number
}

async function resolveBundleAccessDeniedStatus(
  c: Context<MiddlewareKeyVariables>,
  apikey: Database['public']['Tables']['apikeys']['Row'],
  appId: string,
): Promise<never> {
  const { data: appRow, error: appLookupError } = await supabaseApikey(c, apikey.key)
    .from('apps')
    .select('app_id')
    .eq('app_id', appId)
    .maybeSingle()

  if (appLookupError) {
    quickError(500, 'cannot_get_bundle', 'Cannot get bundle', { supabaseError: appLookupError })
  }

  if (!appRow) {
    quickError(404, 'app_not_found', 'App not found', { app_id: appId })
  }

  quickError(403, 'cannot_get_bundle', 'You can\'t access this app', { app_id: appId })
}

export async function get(c: Context<MiddlewareKeyVariables>, body: GetLatest, apikey: Database['public']['Tables']['apikeys']['Row']): Promise<Response> {
  if (!body.app_id) {
    throw simpleError('missing_app_id', 'Missing app_id', { body })
  }
  if (!isValidAppId(body.app_id)) {
    throw simpleError('invalid_app_id', 'App ID must be a reverse domain string', { app_id: body.app_id })
  }

  const auth = c.get('auth')
  if (!auth?.userId) {
    quickError(401, 'invalid_apikey', 'Invalid API key')
  }

  if (!(await checkPermission(c, 'app.read_bundles', { appId: body.app_id }))) {
    return await resolveBundleAccessDeniedStatus(c, apikey, body.app_id)
  }

  // GET callers send page as a query string; coerce so (page + 1) is not string concatenation.
  const requestedPage = Math.trunc(Number(body.page ?? 0))
  const fetchOffset = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 0
  const from = fetchOffset * fetchLimit
  const to = (fetchOffset + 1) * fetchLimit - 1
  const { data: dataBundles, error: dbError } = await supabaseApikey(c, apikey.key)
    .from('app_versions')
    .select()
    .eq('app_id', body.app_id)
    .eq('deleted', false)
    .range(from, to)
    .order('created_at', { ascending: false })
  if (dbError) {
    quickError(500, 'cannot_get_bundle', 'Cannot get bundle', { supabaseError: dbError })
  }

  return c.json(dataBundles ?? [])
}
