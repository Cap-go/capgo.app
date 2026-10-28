import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { BRES, parseBody, quickError, simpleError } from '../utils/hono.ts'
import { middlewareKey } from '../utils/hono_middleware.ts'
import { cloudlog } from '../utils/logging.ts'
import { checkPermission } from '../utils/rbac.ts'
import { s3 } from '../utils/s3.ts'
import type { Database } from '../utils/supabase.types.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { apikeyPrincipal, queryJson, withRlsContext } from '../utils/pg_rls.ts'
import { sendEventToTracking } from '../utils/tracking.ts'

interface DataUpload {
  app_id: string
  name: string
}

// Same shape as the PostgREST `.single()` error.
function singleRowError(rows: number) {
  return { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${rows} rows` }
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

  let errorApp: unknown = null
  try {
    const apps = await withRlsContext(c, apikeyPrincipal(c, capgkey), client => queryJson<{ app_id: string, owner_org: string }>(
      client,
      'SELECT app_id, owner_org FROM public.apps WHERE app_id = $1 LIMIT 2',
      [body.app_id],
    ))
    if (apps.length !== 1)
      errorApp = singleRowError(apps.length)
  }
  catch (error) {
    errorApp = error
  }
  if (errorApp) {
    return quickError(404, 'app_not_found', 'Error App not found', { errorApp })
  }

  if (!body.app_id) {
    return quickError(400, 'error_app_id_missing', 'Error bundle name missing', { body })
  }
  if (!body.name) {
    return quickError(400, 'error_bundle_name_missing', 'Error bundle name missing', { body })
  }

  let version: Database['public']['Tables']['app_versions']['Row'] | undefined
  let errorVersion: unknown = null
  try {
    const versions = await withRlsContext(c, apikeyPrincipal(c, capgkey), client => queryJson<Database['public']['Tables']['app_versions']['Row']>(
      client,
      `SELECT * FROM public.app_versions
      WHERE name = $1 AND app_id = $2 AND storage_provider = 'r2-direct' AND deleted = false
      LIMIT 2`,
      [body.name, body.app_id],
    ))
    if (versions.length === 1)
      version = versions[0]
    else
      errorVersion = singleRowError(versions.length)
  }
  catch (error) {
    errorVersion = error
  }
  if (errorVersion || !version) {
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
  let deletedCount = 0
  const pg = await getPgClient(c)
  try {
    const result = await pg.query(
      `DELETE FROM public.app_versions
      WHERE id = $1 AND storage_provider = 'r2-direct' AND deleted = false
        AND r2_path IS NOT DISTINCT FROM $2::text
        AND ($3::timestamptz IS NULL OR updated_at = $3::timestamptz)
      RETURNING id`,
      [version.id, version.r2_path || null, options.expectedUpdatedAt || null],
    )
    deletedCount = result.rowCount ?? 0
  }
  catch (errorDelete) {
    throw simpleError('error_deleting_version', 'Error deleting version', { errorDelete })
  }
  finally {
    closeClient(c, pg)
  }
  if (!deletedCount) {
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
