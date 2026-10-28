import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { z } from 'zod'
import { quickError, simpleError } from '../../utils/hono.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { integerLikeSchema, numberLikeSchema, safeParseSchema } from '../../utils/schema_validation.ts'
import { apikeyPrincipal, queryJson, queryJsonOne, withRlsContext } from '../../utils/pg_rls.ts'
import { BUNDLE_SUMMARY_COLUMNS } from '../../../shared/bundle-columns.ts'
import { fetchLimit, isValidAppId } from '../../utils/utils.ts'

export { BUNDLE_SUMMARY_COLUMNS }

// PostgREST caps a response at max_rows (1000): never ask for a larger page.
export const BUNDLE_LIST_MAX_LIMIT = 1000

export const getBundleQuerySchema = z.object({
  app_id: z.string().optional(),
  version: z.string().min(1).optional(),
  id: integerLikeSchema.refine(Number.isSafeInteger, { message: 'id must be a safe integer' }).optional(),
  page: numberLikeSchema.optional(),
  // List page size (default 50). `page` counts in pages of this size.
  limit: integerLikeSchema.refine(value => value >= 1 && value <= BUNDLE_LIST_MAX_LIMIT, { message: `limit must be between 1 and ${BUNDLE_LIST_MAX_LIMIT}` }).optional(),
  // `summary` leaves out the heavy per-file `manifest` and `native_packages` arrays.
  fields: z.enum(['full', 'summary']).optional(),
  // Version/id lookups only: also match soft-deleted bundles (name occupancy checks).
  include_deleted: z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])]).optional(),
})

export type GetLatest = z.infer<typeof getBundleQuerySchema> & { app_id: string }

async function resolveBundleAccessDeniedStatus(
  c: Context<MiddlewareKeyVariables>,
  apikey: Database['public']['Tables']['apikeys']['Row'],
  appId: string,
): Promise<never> {
  let appRow: { app_id: string } | null = null
  try {
    appRow = await withRlsContext(c, apikeyPrincipal(c, apikey.key), client =>
      queryJsonOne<{ app_id: string }>(client, 'SELECT app_id FROM public.apps WHERE app_id = $1 LIMIT 2', [appId]))
  }
  catch (appLookupError) {
    quickError(500, 'cannot_get_bundle', 'Cannot get bundle', { supabaseError: appLookupError })
  }

  if (!appRow) {
    quickError(404, 'app_not_found', 'App not found', { app_id: appId })
  }

  quickError(403, 'cannot_get_bundle', 'You can\'t access this app', { app_id: appId })
}

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

  const auth = c.get('auth')
  if (!auth?.userId) {
    quickError(401, 'invalid_apikey', 'Invalid API key')
  }

  if (!(await checkPermission(c, 'app.read_bundles', { appId: body.app_id }))) {
    return await resolveBundleAccessDeniedStatus(c, apikey, body.app_id)
  }

  const principal = apikeyPrincipal(c, apikey.key)
  const columns = body.fields === 'summary' ? BUNDLE_SUMMARY_COLUMNS : '*'
  const hasVersionFilter = body.version !== undefined
  const hasIdFilter = body.id !== undefined

  if (hasVersionFilter || hasIdFilter) {
    const includeDeleted = body.include_deleted === true || body.include_deleted === 'true' || body.include_deleted === '1'
    const conditions = ['app_id = $1']
    const values: unknown[] = [body.app_id]
    if (!includeDeleted)
      conditions.push('deleted = false')
    if (hasVersionFilter) {
      values.push(body.version!)
      conditions.push(`name = $${values.length}`)
    }
    if (hasIdFilter) {
      values.push(body.id!)
      conditions.push(`id = $${values.length}`)
    }

    let rows: unknown[] = []
    try {
      rows = await withRlsContext(c, principal, client =>
        queryJson(client, `SELECT ${columns} FROM public.app_versions WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 1`, values))
    }
    catch (dbError) {
      quickError(500, 'cannot_get_bundle', 'Cannot get bundle', { supabaseError: dbError })
    }

    return c.json(rows.length ? [rows[0]] : [])
  }

  // GET callers send page as a query string; coerce so (page + 1) is not string concatenation.
  const requestedPage = Math.trunc(Number(body.page ?? 0))
  const fetchOffset = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 0
  const pageSize = body.limit ?? fetchLimit
  const from = fetchOffset * pageSize
  let dataBundles: unknown[] = []
  try {
    dataBundles = await withRlsContext(c, principal, client =>
      queryJson(client, `SELECT ${columns} FROM public.app_versions WHERE app_id = $1 AND deleted = false ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [body.app_id, pageSize, from]))
  }
  catch (dbError) {
    quickError(500, 'cannot_get_bundle', 'Cannot get bundle', { supabaseError: dbError })
  }

  return c.json(dataBundles)
}
