import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { simpleError } from '../../utils/hono.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseApikey } from '../../utils/supabase.ts'
import { fetchLimit, isValidAppId } from '../../utils/utils.ts'

export interface GetLatest {
  app_id: string
  version?: string
  page?: number
}

export async function get(c: Context<MiddlewareKeyVariables>, body: GetLatest, apikey: Database['public']['Tables']['apikeys']['Row']): Promise<Response> {
  if (!body.app_id) {
    throw simpleError('missing_app_id', 'Missing app_id', { body })
  }
  if (!isValidAppId(body.app_id)) {
    throw simpleError('invalid_app_id', 'App ID must be a reverse domain string', { app_id: body.app_id })
  }
  // Auth context is already set by middlewareKey
  if (!(await checkPermission(c, 'app.read_bundles', { appId: body.app_id }))) {
    throw simpleError('cannot_get_bundle', 'You can\'t access this app', { app_id: body.app_id })
  }

  const fetchOffset = body.page ?? 0
  const from = fetchOffset * fetchLimit
  const to = (fetchOffset + 1) * fetchLimit - 1
  const { data: dataBundles, error: dbError } = await supabaseApikey(c, apikey.key)
    .from('app_versions')
    .select()
    .eq('app_id', body.app_id)
    .eq('deleted', false)
    .range(from, to)
    .order('created_at', { ascending: false })
  if (dbError || !dataBundles?.length) {
    throw simpleError('cannot_get_bundle', 'Cannot get bundle', { supabaseError: dbError })
  }

  return c.json(dataBundles as any)
}
