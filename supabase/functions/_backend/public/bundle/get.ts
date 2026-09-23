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
  include_deleted?: boolean | string
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

  if (body.version) {
    const includeDeleted = body.include_deleted === true
      || body.include_deleted === 'true'
      || body.include_deleted === '1'
    let query = supabaseApikey(c, apikey.key)
      .from('app_versions')
      .select('id, name, checksum, deleted, created_at')
      .eq('app_id', body.app_id)
      .eq('name', body.version)
    if (!includeDeleted)
      query = query.eq('deleted', false)
    const { data, error: versionError } = await query.maybeSingle()
    if (versionError) {
      throw simpleError('cannot_get_bundle', 'Cannot get bundle', { supabaseError: versionError })
    }
    if (!data) {
      return quickError(404, 'cannot_find_bundle', 'Cannot find bundle', {
        app_id: body.app_id,
        version: body.version,
      })
    }
    return c.json(data)
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
  if (dbError) {
    throw simpleError('cannot_get_bundle', 'Cannot get bundle', { supabaseError: dbError })
  }

  return c.json((dataBundles ?? []) as any)
}
