import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { getBundleUrl, getManifestUrl } from '../utils/downloadUrl.ts'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlog } from '../utils/logging.ts'
import { checkPermission } from '../utils/rbac.ts'
import { supabaseClient } from '../utils/supabase.ts'

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

  // Use authenticated client - RLS will enforce access based on JWT
  const supabase = supabaseClient(c, authorization)

  // Get current user ID from JWT
  const authContext = c.get('auth')
  if (!authContext?.userId)
    throw simpleError('not_authorized', 'Not authorized')

  const userId = authContext.userId

  // Auth context is already set by middlewareAuth
  if (!(await checkPermission(c, 'app.read_bundles', { appId: body.app_id })))
    throw simpleError('app_access_denied', 'You can\'t access this app', { app_id: body.app_id })

  const { data: bundle, error: getBundleError } = await supabase
    .from('app_versions')
    .select('*, owner_org ( created_by )')
    .eq('app_id', body.app_id)
    .eq('id', body.id)
    .single()

  const ownerOrg = bundle?.owner_org.created_by

  if (getBundleError) {
    throw simpleError('cannot_get_bundle', 'Cannot get bundle', { getBundleError })
  }

  if (!ownerOrg) {
    throw simpleError('cannot_get_owner_org', 'Cannot get owner org', { bundle })
  }

  if (body.isManifest) {
    const { data: manifest, error: getManifestError } = await supabase
      .from('manifest')
      .select('*')
      .eq('app_version_id', bundle.id)

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
