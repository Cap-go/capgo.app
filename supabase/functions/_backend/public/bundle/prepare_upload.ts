import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { getBodyOrQuery, honoFactory, simpleError } from '../../utils/hono.ts'
import { middlewareKey } from '../../utils/hono_middleware.ts'
import { closeClient, getPgClient, logPgError } from '../../utils/pg.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseApikey } from '../../utils/supabase.ts'
import { isValidAppId, isValidSemver } from '../../utils/utils.ts'
import { checkEncryptedBundleEnforcement, getAppOrganization, validateUrlFormat } from './create.ts'

export interface PrepareUploadBody {
  app_id: string
  name: string
  session_key?: string | null
  external_url?: string | null
  storage_provider?: Database['public']['Tables']['app_versions']['Insert']['storage_provider'] | null
  min_update_version?: string | null
  native_packages?: Database['public']['Tables']['app_versions']['Insert']['native_packages']
  checksum?: string | null
  link?: string | null
  comment?: string | null
  key_id?: string | null
  cli_version?: string | null
  manifest?: Database['public']['Tables']['app_versions']['Insert']['manifest']
}

const PREPARE_STORAGE_PROVIDERS = new Set(['r2-direct', 'external'])
const COMPLETED_UPLOAD_STORAGE_PROVIDER = 'r2'
const PREPARE_REUPLOAD_UPDATE_COLUMNS = new Set([
  'session_key',
  'external_url',
  'storage_provider',
  'min_update_version',
  'native_packages',
  'checksum',
  'link',
  'comment',
  'key_id',
  'cli_version',
  'manifest',
  'r2_path',
])

interface ExistingVersionRow {
  id: number
  deleted: boolean
  storage_provider: string | null
}

interface PreparedVersionRow {
  id: number
  name: string
  storage_provider: string | null
}

async function loadExistingVersion(
  c: Context<MiddlewareKeyVariables>,
  appId: string,
  name: string,
): Promise<ExistingVersionRow | null> {
  const pgClient = getPgClient(c, false)
  try {
    const result = await pgClient.query<ExistingVersionRow>(
      `SELECT id, deleted, storage_provider
       FROM public.app_versions
       WHERE app_id = $1 AND name = $2
       LIMIT 1`,
      [appId, name],
    )
    return result.rows[0] ?? null
  }
  catch (error) {
    logPgError(c, 'prepare_upload_load_existing', error)
    throw simpleError('cannot_prepare_upload', 'Cannot load existing bundle version', { error })
  }
  finally {
    await closeClient(c, pgClient)
  }
}

async function updateVersionForReupload(
  c: Context<MiddlewareKeyVariables>,
  versionId: number,
  updateFields: Record<string, unknown>,
): Promise<PreparedVersionRow> {
  const entries = Object.entries(updateFields).filter(([key, value]) =>
    PREPARE_REUPLOAD_UPDATE_COLUMNS.has(key) && value !== undefined)
  if (entries.length === 0)
    throw simpleError('cannot_prepare_upload', 'No upload fields to update', { versionId })

  const setClauses = entries.map(([key], index) => `${key} = $${index + 1}`)
  const values = entries.map(([, value]) => value)
  values.push(versionId)

  const pgClient = getPgClient(c, false)
  try {
    await pgClient.query('BEGIN')
    await pgClient.query(`SELECT set_config('capgo.prepare_reupload_reset', 'on', true)`)
    const result = await pgClient.query<PreparedVersionRow>(
      `UPDATE public.app_versions
       SET ${setClauses.join(', ')}
       WHERE id = $${values.length}
       RETURNING id, name, storage_provider`,
      values,
    )
    await pgClient.query('COMMIT')
    const updated = result.rows[0]
    if (!updated)
      throw simpleError('cannot_prepare_upload', 'Cannot update bundle version for upload', { versionId })
    return {
      ...updated,
      id: Number(updated.id),
    }
  }
  catch (error) {
    await pgClient.query('ROLLBACK').catch(() => undefined)
    logPgError(c, 'prepare_upload_reupload_reset', error)
    throw simpleError('cannot_prepare_upload', 'Cannot update bundle version for upload', { error })
  }
  finally {
    await closeClient(c, pgClient)
  }
}

function pickUpsertFields(body: PrepareUploadBody) {
  return {
    ...(body.session_key !== undefined ? { session_key: body.session_key } : {}),
    ...(body.external_url !== undefined ? { external_url: body.external_url } : {}),
    ...(body.storage_provider !== undefined && body.storage_provider !== null
      ? { storage_provider: body.storage_provider }
      : {}),
    ...(body.min_update_version !== undefined ? { min_update_version: body.min_update_version } : {}),
    ...(body.native_packages !== undefined ? { native_packages: body.native_packages } : {}),
    ...(body.checksum !== undefined ? { checksum: body.checksum } : {}),
    ...(body.link !== undefined ? { link: body.link } : {}),
    ...(body.comment !== undefined ? { comment: body.comment } : {}),
    ...(body.key_id !== undefined ? { key_id: body.key_id } : {}),
    ...(body.cli_version !== undefined ? { cli_version: body.cli_version } : {}),
    ...(body.manifest !== undefined ? { manifest: body.manifest } : {}),
  }
}

export async function prepareUpload(
  c: Context<MiddlewareKeyVariables>,
  body: PrepareUploadBody,
  apikey: Database['public']['Tables']['apikeys']['Row'],
): Promise<Response> {
  if (!body.app_id)
    throw simpleError('missing_app_id', 'Missing app_id', { body })
  if (!isValidAppId(body.app_id))
    throw simpleError('invalid_app_id', 'App ID must be a reverse domain string', { app_id: body.app_id })
  if (!body.name)
    throw simpleError('missing_version', 'Missing bundle version name', { body })
  if (!isValidSemver(body.name))
    throw simpleError('invalid_version_format', 'Version must be valid semver format', { version: body.name })

  if (body.external_url != null && body.external_url !== '')
    validateUrlFormat(body.external_url)

  const storageProvider = body.storage_provider ?? 'r2-direct'
  if (!PREPARE_STORAGE_PROVIDERS.has(storageProvider)) {
    throw simpleError('invalid_storage_provider', 'storage_provider must be r2-direct or external', {
      storage_provider: storageProvider,
    })
  }

  if (!(await checkPermission(c, 'app.upload_bundle', { appId: body.app_id })))
    throw simpleError('cannot_prepare_upload', 'You cannot upload bundles for this app', { app_id: body.app_id })

  const appWithOrg = await getAppOrganization(c, body.app_id)
  checkEncryptedBundleEnforcement(appWithOrg, body.session_key ?? undefined, body.key_id ?? undefined)

  const existing = await loadExistingVersion(c, body.app_id, body.name)
  const supabase = supabaseApikey(c, apikey.key)

  const upsertFields = pickUpsertFields(body)

  if (existing) {
    if (existing.deleted)
      throw simpleError('version_name_taken', 'Version name already exists (including deleted versions)', { version: body.name })

    if (existing.storage_provider
      && existing.storage_provider !== COMPLETED_UPLOAD_STORAGE_PROVIDER
      && !PREPARE_STORAGE_PROVIDERS.has(existing.storage_provider)) {
      throw simpleError('version_not_uploadable', 'Version is not in an uploadable state', {
        storage_provider: existing.storage_provider,
      })
    }

    const resetForReupload = existing.storage_provider === COMPLETED_UPLOAD_STORAGE_PROVIDER
    const updateFields = resetForReupload
      ? { ...upsertFields, storage_provider: storageProvider, r2_path: null }
      : upsertFields

    if (resetForReupload) {
      const updated = await updateVersionForReupload(c, existing.id, updateFields)
      return c.json({ status: 'ok', version: updated })
    }

    const { data: updated, error: updateError } = await supabase
      .from('app_versions')
      .update(updateFields)
      .eq('id', existing.id)
      .select('id, name, storage_provider')
      .single()

    if (updateError || !updated)
      throw simpleError('cannot_prepare_upload', 'Cannot update bundle version for upload', { supabaseError: updateError })

    return c.json({ status: 'ok', version: updated })
  }

  const insertRow: Database['public']['Tables']['app_versions']['Insert'] = {
    app_id: body.app_id,
    name: body.name,
    owner_org: appWithOrg.owner_org,
    user_id: apikey.user_id,
    storage_provider: storageProvider,
    deleted: false,
    ...upsertFields,
  }

  const { data: created, error: insertError } = await supabase
    .from('app_versions')
    .insert(insertRow)
    .select('id, name, storage_provider')
    .single()

  if (insertError)
    throw simpleError('cannot_prepare_upload', 'Cannot create bundle version for upload', { supabaseError: insertError })

  return c.json({ status: 'ok', version: created })
}

export const app = honoFactory.createApp()

function requirePrepareUploadBody(body: PrepareUploadBody | null | undefined): PrepareUploadBody {
  if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body))
    throw simpleError('invalid_json_body', 'Invalid JSON body', { body })
  return body
}

app.post('/', middlewareKey({ usePostgres: true, readOnly: false }), async (c) => {
  const body = requirePrepareUploadBody(await getBodyOrQuery<PrepareUploadBody>(c))
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return prepareUpload(c, body, apikey)
})

app.patch('/', middlewareKey({ usePostgres: true, readOnly: false }), async (c) => {
  const body = requirePrepareUploadBody(await getBodyOrQuery<PrepareUploadBody>(c))
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return prepareUpload(c, body, apikey)
})
