import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { z } from 'zod'
import { simpleError } from '../../utils/hono.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { integerLikeSchema, numberLikeSchema, safeParseSchema } from '../../utils/schema_validation.ts'
import { supabaseApikey } from '../../utils/supabase.ts'
import { fetchLimit, isValidAppId } from '../../utils/utils.ts'

export const getBundleQuerySchema = z.object({
  app_id: z.string().optional(),
  version: z.string().min(1).optional(),
  id: integerLikeSchema.refine(Number.isSafeInteger, { message: 'id must be a safe integer' }).optional(),
  page: numberLikeSchema.optional(),
})

export type GetLatest = z.infer<typeof getBundleQuerySchema> & { app_id: string }

export async function get(c: Context<MiddlewareKeyVariables>, bodyRaw: unknown, apikey: Database['public']['Tables']['apikeys']['Row']): Promise<Response> {
  const bodyParsed = safeParseSchema(getBundleQuerySchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_query', 'Invalid query', { error: bodyParsed.error })
  }
  const body = bodyParsed.data

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

  const supabase = supabaseApikey(c, apikey.key)
  const hasVersionFilter = body.version !== undefined
  const hasIdFilter = body.id !== undefined

  if (hasVersionFilter || hasIdFilter) {
    let query = supabase
      .from('app_versions')
      .select()
      .eq('app_id', body.app_id)
      .eq('deleted', false)
      .limit(1)
      .order('created_at', { ascending: false })

    if (hasVersionFilter)
      query = query.eq('name', body.version!)
    if (hasIdFilter)
      query = query.eq('id', body.id!)

    const { data: dataBundles, error: dbError } = await query
    if (dbError) {
      throw simpleError('cannot_get_bundle', 'Cannot get bundle', { supabaseError: dbError })
    }

    const rows = dataBundles ?? []
    return c.json(rows.length ? [rows[0]] : [])
  }

  // GET callers send page as a query string; coerce so (page + 1) is not string concatenation.
  const requestedPage = Math.trunc(Number(body.page ?? 0))
  const fetchOffset = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 0
  const from = fetchOffset * fetchLimit
  const to = (fetchOffset + 1) * fetchLimit - 1
  const { data: dataBundles, error: dbError } = await supabase
    .from('app_versions')
    .select()
    .eq('app_id', body.app_id)
    .eq('deleted', false)
    .range(from, to)
    .order('created_at', { ascending: false })
  if (dbError) {
    throw simpleError('cannot_get_bundle', 'Cannot get bundle', { supabaseError: dbError })
  }

  return c.json(dataBundles ?? [])
}
