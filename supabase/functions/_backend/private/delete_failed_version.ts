import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { BRES, parseBody, quickError, simpleError } from '../utils/hono.ts'
import { middlewareKey } from '../utils/hono_middleware.ts'
import { cloudlog } from '../utils/logging.ts'
import { checkPermission } from '../utils/rbac.ts'
import { s3 } from '../utils/s3.ts'
import { supabaseAdmin, supabaseApikey } from '../utils/supabase.ts'
import { sendEventToTracking } from '../utils/tracking.ts'

interface DataUpload {
  app_id: string
  name: string
}

export const app = new Hono<MiddlewareKeyVariables>()

app.delete('/', middlewareKey(), async (c) => {
  const body = await parseBody<DataUpload>(c)
  cloudlog({ requestId: c.get('requestId'), message: 'delete failed version body', body })
  const apikey = c.get('apikey')
  const capgkey = c.get('capgkey') as string
  if (apikey && typeof apikey === 'object') {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'apikey context',
      apikeyId: (apikey as { id?: number }).id,
      userId: (apikey as { user_id?: string }).user_id,
    })
  }
  // Auth context is already set by middlewareKey
  if (!(await checkPermission(c, 'app.upload_bundle', { appId: body.app_id }))) {
    return quickError(401, 'not_authorized', 'You can\'t access this app', { app_id: body.app_id })
  }

  const { error: errorApp } = await supabaseApikey(c, capgkey)
    .from('apps')
    .select('app_id, owner_org')
    .eq('app_id', body.app_id)
    .single()
  if (errorApp) {
    return quickError(404, 'app_not_found', 'Error App not found', { errorApp })
  }

  if (!body.app_id) {
    return quickError(400, 'error_app_id_missing', 'Error bundle name missing', { body })
  }
  if (!body.name) {
    return quickError(400, 'error_bundle_name_missing', 'Error bundle name missing', { body })
  }

  const { data: version, error: errorVersion } = await supabaseApikey(c, capgkey)
    .from('app_versions')
    .select('*')
    .eq('name', body.name)
    .eq('app_id', body.app_id)
    .eq('storage_provider', 'r2-direct')
    .eq('deleted', false)
    .single()
  if (errorVersion) {
    throw simpleError('error_already_deleted', 'Already deleted', { errorVersion })
  }
  await deleteFailedVersionRow(c, version)
  return c.json(BRES)
})

export interface DeleteFailedVersionOptions {
  /** The caller owns the version's objects and removes them itself after the row is gone. */
  skipObjectCheck?: boolean
  /** Also require this updated_at (compare-and-swap on a stale upload-session claim). */
  expectedUpdatedAt?: string
}

/**
 * Hard-deletes an r2-direct version whose upload never completed. Refuses while the
 * bundle object still exists in storage unless the caller owns the objects.
 *
 * The delete is conditional on the row still being an unfinished upload in the state
 * the caller observed (`storage_provider = 'r2-direct'`, not deleted, same r2_path), so a
 * concurrent finalize or upload-session claim makes it a no-op instead of removing a
 * live bundle. Returns whether a row was deleted.
 */
export async function deleteFailedVersionRow(
  c: Context,
  version: { id: number, r2_path: string | null, owner_org: string },
  options: DeleteFailedVersionOptions = {},
): Promise<boolean> {
  // check if object exist in r2
  if (version.r2_path && !options.skipObjectCheck) {
    const exist = await s3.checkIfExist(c, version.r2_path)
    if (exist) {
      throw simpleError('error_already_uploaded_to_s3', 'Error already uploaded to S3, delete is unsafe use the webapp to delete it')
    }
  }

  // Hard delete after upload-flow checks; upload keys lack bundle.delete RLS
  let query = supabaseAdmin(c)
    .from('app_versions')
    .delete()
    .eq('id', version.id)
    .eq('storage_provider', 'r2-direct')
    .eq('deleted', false)
  query = version.r2_path ? query.eq('r2_path', version.r2_path) : query.is('r2_path', null)
  if (options.expectedUpdatedAt)
    query = query.eq('updated_at', options.expectedUpdatedAt)
  const { data: deletedRows, error: errorDelete } = await query.select('id')
  if (errorDelete) {
    throw simpleError('error_deleting_version', 'Error deleting version', { errorDelete })
  }
  if (!deletedRows?.length) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'delete failed version skipped: no unfinished upload row matched',
      versionId: version.id,
    })
    return false
  }

  await sendEventToTracking(c, {
    channel: 'upload-failed',
    event: 'Failed to upload a bundle',
    user_id: version.owner_org,
    groups: { organization: version.owner_org },
  })

  cloudlog({ requestId: c.get('requestId'), message: 'delete version', id: version.id })
  return true
}
