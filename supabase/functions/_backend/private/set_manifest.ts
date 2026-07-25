import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { ManifestPersistEntry } from '../utils/manifest_persist.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { BRES, parseBody, quickError, simpleError } from '../utils/hono.ts'
import { middlewareKey } from '../utils/hono_middleware.ts'
import { cloudlog } from '../utils/logging.ts'
import { persistVersionManifestEntries } from '../utils/manifest_persist.ts'
import { checkPermission } from '../utils/rbac.ts'
import { supabaseAdmin, supabaseApikey } from '../utils/supabase.ts'

interface DataSetManifest {
  app_id: string
  name: string
  manifest?: ManifestPersistEntry[]
}

// Prod max is ~7.5k files per version; keep modest headroom without unbounded payloads.
const MAX_MANIFEST_ENTRIES = 10_000
const MAX_FILE_NAME_LENGTH = 2048
const MAX_S3_PATH_LENGTH = 2048
const MAX_FILE_HASH_LENGTH = 512

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareKey(), async (c) => {
  const body = await parseBody<DataSetManifest>(c)
  cloudlog({
    requestId: c.get('requestId'),
    message: 'post set_manifest body',
    app_id: body.app_id,
    name: body.name,
    manifest_entries: Array.isArray(body.manifest) ? body.manifest.length : 0,
  })

  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  const capgkey = c.get('capgkey') as string

  if (!body.app_id)
    return quickError(400, 'error_app_id_missing', 'Error app_id missing', { body })
  if (!body.name)
    return quickError(400, 'error_bundle_name_missing', 'Error bundle name missing', { body })
  if (!Array.isArray(body.manifest) || body.manifest.length === 0)
    return quickError(400, 'error_manifest_missing', 'Error manifest missing or empty', { body })
  if (body.manifest.length > MAX_MANIFEST_ENTRIES) {
    return quickError(400, 'error_manifest_too_large', 'Manifest has too many entries', {
      max: MAX_MANIFEST_ENTRIES,
      count: body.manifest.length,
    })
  }

  if (!(await checkPermission(c, 'app.upload_bundle', { appId: body.app_id })))
    return quickError(401, 'not_authorized', 'You can\'t access this app', { app_id: body.app_id })

  const { data: appRow, error: errorApp } = await supabaseApikey(c, capgkey)
    .from('apps')
    .select('app_id, owner_org')
    .eq('app_id', body.app_id)
    .single()
  if (errorApp || !appRow)
    return quickError(404, 'app_not_found', 'Error App not found', { errorApp })

  const { data: version, error: errorVersion } = await supabaseApikey(c, capgkey)
    .from('app_versions')
    .select('id, app_id, name, storage_provider, deleted, owner_org')
    .eq('name', body.name)
    .eq('app_id', body.app_id)
    .eq('deleted', false)
    .single()
  if (errorVersion || !version)
    return quickError(404, 'error_version_not_found', 'Error Version not found', { errorVersion })

  const s3PathPrefix = `orgs/${appRow.owner_org}/apps/${appRow.app_id}/`
  const invalidEntry = body.manifest.find(entry =>
    !entry?.file_name
    || !entry?.file_hash
    || !entry?.s3_path
    || entry.file_name.length > MAX_FILE_NAME_LENGTH
    || entry.file_hash.length > MAX_FILE_HASH_LENGTH
    || entry.s3_path.length > MAX_S3_PATH_LENGTH
    || !entry.s3_path.startsWith(s3PathPrefix),
  )
  if (invalidEntry) {
    return quickError(400, 'error_manifest_invalid', 'Manifest entries must include file_name, file_hash, and an s3_path under this app', {
      app_id: body.app_id,
      s3_path_prefix: s3PathPrefix,
    })
  }

  // After storage_provider flips to r2, only idempotent retries are allowed.
  if (version.storage_provider === 'r2') {
    const { data: existingEntries, error: existingError } = await supabaseAdmin(c)
      .from('manifest')
      .select('id')
      .eq('app_version_id', version.id)
      .limit(1)
    if (existingError)
      throw simpleError('error_set_manifest', 'Failed to check existing manifest', { existingError })
    if (!existingEntries?.length) {
      return quickError(400, 'error_version_already_finalized', 'Version upload already finalized without a direct manifest write window', {
        storage_provider: version.storage_provider,
      })
    }
    return c.json({ ...BRES, inserted: 0, alreadyPresent: true })
  }

  if (version.storage_provider !== 'r2-direct') {
    return quickError(400, 'error_version_not_uploadable', 'Version is not in an uploadable state', {
      storage_provider: version.storage_provider,
    })
  }

  try {
    const result = await persistVersionManifestEntries(
      c,
      { id: version.id, app_id: version.app_id },
      body.manifest,
      { s3PathPrefix },
    )

    cloudlog({
      requestId: c.get('requestId'),
      message: 'set_manifest done',
      version_id: version.id,
      inserted: result.inserted,
      alreadyPresent: result.alreadyPresent,
      apikeyId: apikey?.id,
    })

    return c.json({
      ...BRES,
      inserted: result.inserted,
      alreadyPresent: result.alreadyPresent,
    })
  }
  catch (error) {
    throw simpleError('error_set_manifest', 'Failed to set manifest', { error })
  }
})
