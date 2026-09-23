import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { simpleError } from '../../utils/hono.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseAdmin, supabaseApikey } from '../../utils/supabase.ts'
import { isValidAppId, isValidSemver } from '../../utils/utils.ts'

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

interface AppWithOrg {
  owner_org: string
  orgs: {
    enforce_encrypted_bundles: boolean
    required_encryption_key: string | null
  }
}

async function getAppOrganization(c: Context, appId: string): Promise<AppWithOrg> {
  const { data: app, error: appError } = await supabaseAdmin(c)
    .from('apps')
    .select('owner_org, orgs!inner(enforce_encrypted_bundles, required_encryption_key)')
    .eq('app_id', appId)
    .single()

  if (appError || !app) {
    throw simpleError('cannot_find_app', 'Cannot find app', { supabaseError: appError })
  }

  return app as unknown as AppWithOrg
}

function checkEncryptedBundleEnforcement(
  appWithOrg: AppWithOrg,
  sessionKey: string | null | undefined,
  keyId: string | null | undefined,
): void {
  if (!appWithOrg.orgs.enforce_encrypted_bundles) {
    return
  }

  if (!sessionKey || sessionKey === '') {
    throw simpleError('encryption_required', 'This organization requires all bundles to be encrypted. Please upload an encrypted bundle with a session_key.', {
      enforce_encrypted_bundles: true,
    })
  }

  const requiredKey = appWithOrg.orgs.required_encryption_key
  if (requiredKey && requiredKey !== '') {
    if (!keyId || keyId === '') {
      throw simpleError('encryption_key_required', 'This organization requires bundles to be encrypted with a specific key. The uploaded bundle does not have a key_id.', {
        enforce_encrypted_bundles: true,
        required_encryption_key: true,
      })
    }

    const matches = keyId === requiredKey.substring(0, 20) || keyId.startsWith(requiredKey)
    if (!matches) {
      throw simpleError('encryption_key_mismatch', 'This organization requires bundles to be encrypted with a specific key. The uploaded bundle was encrypted with a different key.', {
        enforce_encrypted_bundles: true,
        required_encryption_key: true,
        expected_key_prefix: `${requiredKey.substring(0, 4)}...`,
      })
    }
  }
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
    row.storage_provider = body.storage_provider
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

export async function upsertBundle(
  c: Context<MiddlewareKeyVariables>,
  body: UpsertBundleBody,
  apikey: Database['public']['Tables']['apikeys']['Row'],
): Promise<Response> {
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

  const supabase = supabaseApikey(c, apikey.key)
  const { data: existingVersion, error: existingError } = await supabase
    .from('app_versions')
    .select('id, deleted')
    .eq('app_id', body.app_id)
    .eq('name', body.name)
    .maybeSingle()

  if (existingError) {
    throw simpleError('cannot_upsert_bundle', 'Cannot upsert bundle', { supabaseError: existingError })
  }

  if (existingVersion?.deleted) {
    throw simpleError('version_name_unavailable', 'Version name is unavailable because a deleted bundle still occupies it', { version: body.name })
  }

  const appWithOrg = await getAppOrganization(c, body.app_id)
  if (!existingVersion) {
    checkEncryptedBundleEnforcement(appWithOrg, body.session_key, body.key_id)
  }

  const row = buildUpsertRow(body, appWithOrg.owner_org, apikey.user_id)
  const { data: upserted, error: upsertError } = await supabase
    .from('app_versions')
    .upsert(row, { onConflict: 'name,app_id' })
    .select()
    .single()

  if (upsertError || !upserted) {
    throw simpleError('cannot_upsert_bundle', 'Cannot upsert bundle', { supabaseError: upsertError })
  }

  return c.json(upserted)
}
