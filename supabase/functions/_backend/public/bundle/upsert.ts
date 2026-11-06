import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { checkPermission } from '../../utils/rbac.ts'
import type { PgQueryClient } from '../../utils/pg.ts'
import { apikeyPrincipal, queryJsonOne, withRlsContext } from '../../utils/pg_rls.ts'
import { isValidAppId, isValidSemver } from '../../utils/utils.ts'
import { checkEncryptedBundleEnforcement, getAppOrganization } from './encryption_policy.ts'

export interface UpsertBundleBody {
  app_id: string
  name: string
  session_key?: string | null
  external_url?: string | null
  storage_provider?: string | null
  min_update_version?: string | null
  native_packages?: Database['public']['Tables']['app_versions']['Insert']['native_packages']
  checksum?: string | null
  link?: string | null
  comment?: string | null
  key_id?: string | null
  cli_version?: string | null
  manifest?: Database['public']['Tables']['app_versions']['Insert']['manifest']
  r2_path?: string | null
}

function buildUpsertRow(
  body: UpsertBundleBody,
  ownerOrg: string,
  userId: string,
): Database['public']['Tables']['app_versions']['Insert'] {
  const row: Database['public']['Tables']['app_versions']['Insert'] = {
    app_id: body.app_id,
    name: body.name,
    owner_org: ownerOrg,
    user_id: userId,
  }

  if (body.session_key !== undefined)
    row.session_key = body.session_key
  if (body.external_url !== undefined)
    row.external_url = body.external_url
  if (body.storage_provider !== undefined)
    row.storage_provider = body.storage_provider ?? undefined
  if (body.min_update_version !== undefined)
    row.min_update_version = body.min_update_version
  if (body.native_packages !== undefined)
    row.native_packages = body.native_packages
  if (body.checksum !== undefined)
    row.checksum = body.checksum
  if (body.link !== undefined)
    row.link = body.link
  if (body.comment !== undefined)
    row.comment = body.comment
  if (body.key_id !== undefined)
    row.key_id = body.key_id
  if (body.cli_version !== undefined)
    row.cli_version = body.cli_version
  if (body.manifest !== undefined)
    row.manifest = body.manifest
  if (body.r2_path !== undefined)
    row.r2_path = body.r2_path

  return row
}

type AppVersionRow = Database['public']['Tables']['app_versions']['Row']

/**
 * Inserts (or with `upsert`, merges on name+app_id) an app_versions row and returns it as
 * PostgREST did. The row goes through json_populate_record like a PostgREST body, so json
 * values for jsonb[] / manifest_entry[] columns convert the same way.
 */
export async function writeAppVersionRow(
  client: PgQueryClient,
  row: Database['public']['Tables']['app_versions']['Insert'],
  options: { upsert: boolean },
): Promise<AppVersionRow | null> {
  // Like JSON.stringify in supabase-js, undefined values are not written.
  const columns = Object.entries(row)
    .filter(([, value]) => value !== undefined)
    .map(([column]) => `"${column.replaceAll('"', '""')}"`)
  const conflict = options.upsert
    ? ` ON CONFLICT (name, app_id) DO UPDATE SET ${columns.map(column => `${column} = EXCLUDED.${column}`).join(', ')}`
    : ''
  return queryJsonOne<AppVersionRow>(
    client,
    `INSERT INTO public.app_versions (${columns.join(', ')})
    SELECT ${columns.join(', ')} FROM pg_catalog.json_populate_record(NULL::public.app_versions, $1::json)${conflict}
    RETURNING *`,
    [JSON.stringify(row)],
  )
}

/**
 * Validation shared by every API write of an app_versions row (upsert and insert-only
 * create): body checks, app.upload_bundle, deleted-name guard and the org encryption policy.
 */
async function prepareBundleWrite(
  c: Context<MiddlewareKeyVariables>,
  body: UpsertBundleBody,
  apikey: Database['public']['Tables']['apikeys']['Row'],
) {
  if (!body.app_id) {
    throw simpleError('missing_app_id', 'Missing app_id', { body })
  }
  if (!isValidAppId(body.app_id)) {
    throw simpleError('invalid_app_id', 'App ID must be a reverse domain string', { app_id: body.app_id })
  }
  if (!body.name) {
    throw simpleError('missing_version', 'Missing bundle version name', { name: body.name })
  }
  if (!isValidSemver(body.name)) {
    throw simpleError('invalid_version_format', 'Version must be valid semver format (e.g., 1.0.0, 1.0.0-alpha.1)', { version: body.name })
  }

  if (!(await checkPermission(c, 'app.upload_bundle', { appId: body.app_id }))) {
    throw simpleError('cannot_upsert_bundle', 'You can\'t upload bundles to this app', { app_id: body.app_id })
  }

  const principal = apikeyPrincipal(c, apikey.key)
  let existingVersion: { id: number, deleted: boolean, session_key: string | null, key_id: string | null } | null = null
  try {
    existingVersion = await withRlsContext(c, principal, client => queryJsonOne(
      client,
      'SELECT id, deleted, session_key, key_id FROM public.app_versions WHERE app_id = $1 AND name = $2',
      [body.app_id, body.name],
    ))
  }
  catch (existingError) {
    throw simpleError('cannot_upsert_bundle', 'Cannot upsert bundle', { supabaseError: existingError })
  }

  if (existingVersion?.deleted) {
    throw simpleError('version_name_unavailable', 'Version name is unavailable because a deleted bundle still occupies it', { version: body.name })
  }

  const appWithOrg = await getAppOrganization(c, body.app_id)
  // New versions are always checked. Updates are checked whenever they touch the
  // encryption fields, using the merged result, so an upsert cannot null or swap
  // session_key/key_id past the org policy. Updates that only set other fields
  // (e.g. r2_path after a TUS upload) keep working on pre-existing versions.
  const touchesEncryption = body.session_key !== undefined || body.key_id !== undefined
  if (!existingVersion || touchesEncryption) {
    checkEncryptedBundleEnforcement(
      appWithOrg,
      body.session_key !== undefined ? body.session_key : existingVersion?.session_key,
      body.key_id !== undefined ? body.key_id : existingVersion?.key_id,
    )
  }

  return { principal, existingVersion, row: buildUpsertRow(body, appWithOrg.owner_org, apikey.user_id) }
}

export async function upsertBundle(
  c: Context<MiddlewareKeyVariables>,
  body: UpsertBundleBody,
  apikey: Database['public']['Tables']['apikeys']['Row'],
): Promise<Response> {
  const { principal, row } = await prepareBundleWrite(c, body, apikey)
  let upserted: AppVersionRow | null = null
  try {
    upserted = await withRlsContext(c, principal, client => writeAppVersionRow(client, row, { upsert: true }))
  }
  catch (upsertError) {
    throw simpleError('cannot_upsert_bundle', 'Cannot upsert bundle', { supabaseError: upsertError })
  }
  if (!upserted) {
    throw simpleError('cannot_upsert_bundle', 'Cannot upsert bundle', { supabaseError: null })
  }

  return c.json(upserted)
}

/**
 * Create a new version, never touching an existing one: a concurrent create of the same
 * name loses with 409 version_already_exists instead of overwriting the winner.
 */
export async function insertBundle(
  c: Context<MiddlewareKeyVariables>,
  body: UpsertBundleBody,
  apikey: Database['public']['Tables']['apikeys']['Row'],
): Promise<AppVersionRow> {
  const alreadyExists = () => quickError(409, 'version_already_exists', `Version ${body.name} already exists. Pick a new version.`, { version: body.name })
  const { principal, row, existingVersion } = await prepareBundleWrite(c, body, apikey)
  if (existingVersion)
    throw alreadyExists()
  let inserted: AppVersionRow | null = null
  try {
    inserted = await withRlsContext(c, principal, client => writeAppVersionRow(client, row, { upsert: false }))
  }
  catch (insertError) {
    if ((insertError as { code?: string })?.code === '23505')
      throw alreadyExists()
    throw simpleError('cannot_upsert_bundle', 'Cannot create bundle', { supabaseError: insertError })
  }
  if (!inserted) {
    throw simpleError('cannot_upsert_bundle', 'Cannot create bundle', { supabaseError: null })
  }
  return inserted
}
