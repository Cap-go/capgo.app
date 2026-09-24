import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { BRES, parseBody, quickError, simpleError } from '../utils/hono.ts'
import { middlewareKey } from '../utils/hono_middleware.ts'
import { checkPermission } from '../utils/rbac.ts'
import { supabaseAdmin } from '../utils/supabase.ts'

interface FinalizeBundleUploadBody {
  version_id?: unknown
}

const VERSION_FIELDS = 'id, app_id, deleted, deleted_at, storage_provider'

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareKey(), async (c) => {
  const body = await parseBody<FinalizeBundleUploadBody>(c)
  const versionId = body?.version_id

  if (typeof versionId !== 'number' || !Number.isSafeInteger(versionId) || versionId <= 0)
    return quickError(400, 'error_version_id_invalid', 'version_id must be a positive integer')

  const admin = supabaseAdmin(c)
  const { data: version, error: loadError } = await admin
    .from('app_versions')
    .select(VERSION_FIELDS)
    .eq('id', versionId)
    .maybeSingle()

  if (loadError)
    throw simpleError('error_finalize_bundle_upload', 'Failed to load version', { loadError })
  if (!version)
    return quickError(404, 'error_version_not_found', 'Version not found')

  if (!(await checkPermission(c, 'app.upload_bundle', { appId: version.app_id })))
    return quickError(401, 'not_authorized', 'Not authorized')

  if (version.deleted || version.deleted_at)
    return quickError(400, 'error_version_deleted', 'Deleted versions cannot be finalized')
  if (version.storage_provider === 'r2')
    return c.json(BRES)
  if (version.storage_provider !== 'r2-direct') {
    return quickError(400, 'error_version_not_finalizable', 'Version cannot be finalized from its current storage provider', {
      storage_provider: version.storage_provider,
    })
  }

  const { data: updated, error: updateError } = await admin
    .from('app_versions')
    .update({ storage_provider: 'r2' })
    .eq('id', versionId)
    .eq('app_id', version.app_id)
    .eq('deleted', false)
    .is('deleted_at', null)
    .eq('storage_provider', 'r2-direct')
    .select('id')

  if (updateError)
    throw simpleError('error_finalize_bundle_upload', 'Failed to finalize version', { updateError })
  if (updated?.length)
    return c.json(BRES)

  const { data: current, error: reloadError } = await admin
    .from('app_versions')
    .select(VERSION_FIELDS)
    .eq('id', versionId)
    .maybeSingle()

  if (reloadError)
    throw simpleError('error_finalize_bundle_upload', 'Failed to reload version', { reloadError })
  if (!current)
    return quickError(404, 'error_version_not_found', 'Version not found')
  if (current.app_id !== version.app_id && !(await checkPermission(c, 'app.upload_bundle', { appId: current.app_id })))
    return quickError(401, 'not_authorized', 'Not authorized')
  if (current.deleted || current.deleted_at)
    return quickError(400, 'error_version_deleted', 'Deleted versions cannot be finalized')
  if (current.storage_provider === 'r2')
    return c.json(BRES)
  return quickError(400, 'error_version_not_finalizable', 'Version cannot be finalized from its current storage provider', {
    storage_provider: current.storage_provider,
  })
})
