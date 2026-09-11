import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { getBodyOrQuery, honoFactory, simpleError } from '../../utils/hono.ts'
import { middlewareKey } from '../../utils/hono_middleware.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseApikey } from '../../utils/supabase.ts'
import { isValidAppId } from '../../utils/utils.ts'

interface LookupBody {
  app_id: string
  name?: string
  latest?: boolean | string
}

export async function lookupBundle(
  c: Context<MiddlewareKeyVariables>,
  body: LookupBody,
  apikey: Database['public']['Tables']['apikeys']['Row'],
): Promise<Response> {
  if (!body.app_id)
    throw simpleError('missing_app_id', 'Missing app_id', { body })
  if (!isValidAppId(body.app_id))
    throw simpleError('invalid_app_id', 'App ID must be a reverse domain string', { app_id: body.app_id })

  if (!(await checkPermission(c, 'app.read_bundles', { appId: body.app_id }))
    && !(await checkPermission(c, 'app.upload_bundle', { appId: body.app_id }))) {
    throw simpleError('cannot_lookup_bundle', 'You cannot read bundles for this app', { app_id: body.app_id })
  }

  const supabase = supabaseApikey(c, apikey.key)

  if (body.latest === true || body.latest === 'true' || body.latest === '1') {
    const { data, error } = await supabase
      .from('app_versions')
      .select('name')
      .eq('app_id', body.app_id)
      .eq('deleted', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error)
      throw simpleError('cannot_lookup_bundle', 'Cannot load latest bundle version', { supabaseError: error })

    return c.json({ name: data?.name ?? null })
  }

  if (!body.name)
    throw simpleError('missing_version', 'Missing bundle version name', { body })

  const { data, error } = await supabase
    .from('app_versions')
    .select('id, name, deleted')
    .eq('app_id', body.app_id)
    .eq('name', body.name)
    .maybeSingle()

  if (error)
    throw simpleError('cannot_lookup_bundle', 'Cannot lookup bundle version', { supabaseError: error })

  return c.json({
    exists: !!data,
    id: data?.id ?? null,
    name: data?.name ?? null,
    deleted: data?.deleted ?? null,
  })
}

export const app = honoFactory.createApp()

app.get('/', middlewareKey(), async (c) => {
  const body = await getBodyOrQuery<LookupBody>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return lookupBundle(c, body, apikey)
})
