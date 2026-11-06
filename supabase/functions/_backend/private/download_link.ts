import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { getBundleUrl, getManifestUrl } from '../utils/downloadUrl.ts'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlog } from '../utils/logging.ts'
import { checkPermission } from '../utils/rbac.ts'
import { authPrincipal, queryJson, withRlsContext } from '../utils/pg_rls.ts'

interface DataDownload {
  app_id: string
  storage_provider: string
  user_id?: string
  id: number
  isManifest?: boolean
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

app.post('/', middlewareAuth, async (c) => {
  const body = await parseBody<DataDownload>(c)
  cloudlog({ requestId: c.get('requestId'), message: 'post download link body', body })
  const authorization = c.get('authorization')
  if (!authorization)
    throw simpleError('cannot_find_authorization', 'Cannot find authorization')

  // Get current user ID from JWT
  const authContext = c.get('auth')
  if (!authContext?.userId)
    throw simpleError('not_authorized', 'Not authorized')

  const userId = authContext.userId

  // Auth context is already set by middlewareAuth
  if (!(await checkPermission(c, 'app.read_bundles', { appId: body.app_id })))
    throw simpleError('app_access_denied', 'You can\'t access this app', { app_id: body.app_id })

  // Authenticated context - RLS will enforce access based on JWT
  type BundleRow = Omit<Database['public']['Tables']['app_versions']['Row'], 'owner_org'> & { owner_org: { created_by: string } }
  let bundle: BundleRow | null = null
  let getBundleError: unknown = null
  try {
    const rows = await withRlsContext(c, authPrincipal(c), client => queryJson<BundleRow>(
      client,
      `SELECT av.*, (SELECT pg_catalog.json_build_object('created_by', o.created_by) FROM public.orgs o WHERE o.id = av.owner_org) AS owner_org
      FROM public.app_versions av
      WHERE av.app_id = $1 AND av.id = $2
      LIMIT 2`,
      [body.app_id, body.id],
    ))
    if (rows.length !== 1)
      throw Object.assign(new Error('JSON object requested, multiple (or no) rows returned'), { code: 'PGRST116' })
    bundle = rows[0]
  }
  catch (error) {
    getBundleError = error
  }

  const ownerOrg = bundle?.owner_org.created_by

  if (getBundleError) {
    throw simpleError('cannot_get_bundle', 'Cannot get bundle', { getBundleError })
  }

  if (!bundle || !ownerOrg) {
    throw simpleError('cannot_get_owner_org', 'Cannot get owner org', { bundle })
  }

  if (body.isManifest) {
    let manifest: { file_name: string, file_hash: string, s3_path: string }[] = []
    let getManifestError: unknown = null
    try {
      // PostgREST capped this read at max_rows (1000).
      manifest = await withRlsContext(c, authPrincipal(c), client => queryJson<{ file_name: string, file_hash: string, s3_path: string }>(
        client,
        'SELECT file_name, file_hash, s3_path FROM public.version_manifest WHERE app_version_id = $1 LIMIT 1000',
        [bundle.id],
      ))
    }
    catch (error) {
      getManifestError = error
    }

    if (getManifestError) {
      throw simpleError('cannot_get_manifest', 'Cannot get manifest', { getManifestError })
    }
    const manifestEntries = getManifestUrl(c, bundle.id, manifest, userId)
    return c.json({ manifest: manifestEntries })
  }
  else {
    const url = await getBundleUrl(c, bundle.r2_path, userId, bundle.checksum ?? '')
    if (!url)
      throw simpleError('cannot_get_bundle_url', 'Cannot get bundle url')

    return c.json({ url })
  }
})
