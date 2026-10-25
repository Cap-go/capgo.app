/**
 * Stored native build credentials (per app, per platform).
 *
 * GET    /build/credentials?app_id=            -> non-secret summary per platform (app.build_native)
 * PUT    /build/credentials                    -> validate, encrypt, upsert         (app.update_settings)
 * DELETE /build/credentials                    -> delete one platform               (app.update_settings)
 * POST   /build/credentials/upload-url         -> 10 min signed upload capability   (app.update_settings)
 * PUT    /build/credentials/upload/:token      -> raw JSON credentials, token auth only; single use; permission re-checked
 *
 * Secrets never leave this module in clear except toward the builder in /build/request.
 * Request bodies are read from the raw stream (not cloned) so error reporters cannot
 * re-read and forward them; nothing here logs credential values.
 */
import type { Context } from 'hono'
import type { BuildCredentialsUploadClaims, BuildCredentialsWriteMode } from '../../utils/build_credentials_crypto.ts'
import type { BuildCredentialsSummary, BuildPlatform, CredentialRecord } from '../../utils/build_credentials_validation.ts'
import type { Database, Json } from '../../utils/supabase.types.ts'
import { sql } from 'drizzle-orm'
import {
  BUILD_CREDENTIALS_UPLOAD_TTL_SECONDS,
  createBuildCredentialsUploadToken,
  getBuildCredentialsKeyring,
  getBuildCredentialsUploadSecret,
  openBuildCredentials,
  sealBuildCredentials,
  verifyBuildCredentialsUploadToken,
} from '../../utils/build_credentials_crypto.ts'
import {
  assertStorableCredentialKeys,
  BuildCredentialsValidationError,
  normalizeCredentialValues,
  parseCredentialRecord,
  summarizeCredentials,
  withoutStoredReservedEnvKeys,
} from '../../utils/build_credentials_validation.ts'
import { quickError } from '../../utils/hono.ts'
import { cloudlog, cloudlogErr, serializeError } from '../../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../../utils/pg.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseAdmin } from '../../utils/supabase.ts'
import { getEnv } from '../../utils/utils.ts'

type ApikeyRow = Database['public']['Tables']['apikeys']['Row']

/** JSON body cap for PUT /build/credentials (base64 keystores/certs are a few hundred KB). */
export const BUILD_CREDENTIALS_MAX_BODY_BYTES = 10 * 1024 * 1024
const PLATFORMS: readonly BuildPlatform[] = ['ios', 'android']
const READ_PERMISSION = 'app.build_native' as const
// Signing secrets are admin-grade: only roles that can change app settings
// (app_admin, org_admin, org_super_admin) may write or delete them.
const WRITE_PERMISSION = 'app.update_settings' as const

export interface PutBuildCredentialsBody {
  app_id: string
  platform: BuildPlatform
  credentials: Record<string, string>
  mode?: BuildCredentialsWriteMode
}

export interface BuildCredentialsWriteResponse {
  app_id: string
  platform: BuildPlatform
  mode: BuildCredentialsWriteMode
  updated_at: string
  summary: BuildCredentialsSummary
}

export interface BuildCredentialsPlatformStatus {
  platform: BuildPlatform
  configured: boolean
  updated_at?: string
  created_at?: string
  summary?: BuildCredentialsSummary
}

function invalid(message: string): never {
  quickError(400, 'invalid_parameter', message, {}, undefined, { alert: false })
}

function asValidationError(error: unknown): never {
  if (error instanceof BuildCredentialsValidationError)
    quickError(400, 'invalid_build_credentials', error.message, {}, undefined, { alert: false })
  throw error
}

function parseAppId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    quickError(400, 'missing_parameter', 'app_id is required', {}, undefined, { alert: false })
  if (value.length > 255 || !/^[\w.-]+$/.test(value))
    invalid('app_id is invalid')
  return value
}

function parsePlatform(value: unknown): BuildPlatform {
  if (value === undefined || value === null || value === '')
    quickError(400, 'missing_parameter', 'platform is required', {}, undefined, { alert: false })
  if (!PLATFORMS.includes(value as BuildPlatform))
    invalid('platform must be ios or android')
  return value as BuildPlatform
}

function parseMode(value: unknown): BuildCredentialsWriteMode {
  if (value === undefined || value === null || value === '')
    return 'replace'
  if (value !== 'replace' && value !== 'merge')
    invalid('mode must be replace or merge')
  return value
}

/** Reads the raw request body once with a hard size cap (never cloned, never logged). */
async function readRawBody(c: Context, maxBytes = BUILD_CREDENTIALS_MAX_BODY_BYTES): Promise<string> {
  const declared = Number(c.req.header('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes)
    quickError(413, 'payload_too_large', `Credentials body must be at most ${maxBytes} bytes`, {}, undefined, { alert: false })
  const stream = c.req.raw.body
  if (!stream)
    return ''
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done)
      break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      quickError(413, 'payload_too_large', `Credentials body must be at most ${maxBytes} bytes`, {}, undefined, { alert: false })
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  const text = await readRawBody(c)
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : {}
  }
  catch {
    invalid('Body must be valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    invalid('Body must be a JSON object')
  return parsed as Record<string, unknown>
}

async function requireAppPermission(c: Context, permission: typeof READ_PERMISSION | typeof WRITE_PERMISSION, appId: string) {
  if (!(await checkPermission(c, permission, { appId }))) {
    cloudlog({ requestId: c.get('requestId'), message: 'Build credentials permission denied', app_id: appId, permission })
    quickError(403, 'permission_denied', `Capgo permission denied: you do not have ${permission} for this app.`, { app_id: appId, permission }, undefined, { alert: false })
  }
}

async function getAppOwnerOrg(c: Context, appId: string): Promise<string> {
  const { data, error } = await supabaseAdmin(c)
    .from('apps')
    .select('owner_org')
    .eq('app_id', appId)
    .maybeSingle()
  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Build credentials app lookup failed', app_id: appId, error })
    quickError(503, 'database_unavailable', 'Cannot load app')
  }
  if (!data)
    quickError(404, 'app_not_found', 'App not found', { app_id: appId }, undefined, { alert: false })
  return data.owner_org
}

type StoredRow = Pick<Database['public']['Tables']['app_build_credentials']['Row'], 'id' | 'platform' | 'ciphertext' | 'key_version' | 'summary' | 'created_at' | 'updated_at' | 'created_by'>

async function loadStoredRows(c: Context, appId: string, platform?: BuildPlatform): Promise<StoredRow[]> {
  let query = supabaseAdmin(c)
    .from('app_build_credentials')
    .select('id, platform, ciphertext, key_version, summary, created_at, updated_at, created_by')
    .eq('app_id', appId)
  if (platform)
    query = query.eq('platform', platform)
  const { data, error } = await query
  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Build credentials load failed', app_id: appId, platform, error })
    quickError(503, 'database_unavailable', 'Cannot load stored build credentials')
  }
  return data ?? []
}

/**
 * Re-encrypts a row opened with the previous key, so rotation completes on read and
 * BUILD_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS can be dropped. Best effort: guarded by the
 * key version read, so a concurrent write is never overwritten.
 */
async function resealWithCurrentKey(c: Context, secret: string, appId: string, platform: BuildPlatform, row: StoredRow, credentials: CredentialRecord) {
  try {
    const sealed = await sealBuildCredentials({ secret, appId, platform, credentials })
    const { error } = await supabaseAdmin(c)
      .from('app_build_credentials')
      .update({ ciphertext: sealed.ciphertext, key_version: sealed.keyVersion })
      .eq('id', row.id)
      .eq('key_version', row.key_version)
    if (error)
      cloudlogErr({ requestId: c.get('requestId'), message: 'Build credentials reseal failed', app_id: appId, platform, error })
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Build credentials reseal failed', app_id: appId, platform, error: (error as Error)?.message })
  }
}

/**
 * Decrypts the stored credentials for one app/platform; null when none are stored.
 * Used by /build/request (use_stored_credentials). Caller must have checked permission.
 */
export async function loadStoredBuildCredentials(c: Context, appId: string, platform: BuildPlatform): Promise<CredentialRecord | null> {
  const [row] = await loadStoredRows(c, appId, platform)
  if (!row)
    return null
  const keyring = getBuildCredentialsKeyring(c)
  try {
    const { credentials, needsReseal } = await openBuildCredentials({ keyring, appId, platform, ciphertext: row.ciphertext, keyVersion: row.key_version })
    if (needsReseal)
      await resealWithCurrentKey(c, keyring.current, appId, platform, row, credentials)
    return credentials
  }
  catch (error) {
    // Message only: never serialize the ciphertext or plaintext.
    cloudlogErr({ requestId: c.get('requestId'), message: 'Stored build credentials cannot be decrypted', app_id: appId, platform, key_version: row.key_version, error: (error as Error)?.message })
    quickError(500, 'build_credentials_decrypt_failed', 'Stored build credentials cannot be decrypted. Save them again with `npx @capgo/cli@latest build credentials push`.', { app_id: appId, platform })
  }
}

interface AuditActor {
  userId: string
  apikeyId: number | null
  apikeyName: string | null
}

/** Summary-only audit row; the generic audit trigger is not used because it would copy ciphertext. */
async function writeAuditLog(c: Context, input: {
  orgId: string
  recordId: string
  operation: 'INSERT' | 'UPDATE' | 'DELETE'
  actor: AuditActor
  appId: string
  platform: BuildPlatform
  oldSummary: Json | null
  newSummary: Json | null
}) {
  const { error } = await supabaseAdmin(c).from('audit_logs').insert({
    table_name: 'app_build_credentials',
    record_id: input.recordId,
    operation: input.operation,
    org_id: input.orgId,
    user_id: input.actor.userId,
    actor_type: input.actor.apikeyId ? 'apikey' : 'user',
    actor_user_id: input.actor.userId,
    actor_apikey_id: input.actor.apikeyId,
    actor_apikey_name: input.actor.apikeyName,
    old_record: input.oldSummary === null ? null : { app_id: input.appId, platform: input.platform, summary: input.oldSummary },
    new_record: input.newSummary === null ? null : { app_id: input.appId, platform: input.platform, summary: input.newSummary },
    changed_fields: input.operation === 'UPDATE' ? ['credentials'] : null,
  })
  if (error)
    cloudlogErr({ requestId: c.get('requestId'), message: 'Build credentials audit log insert failed', app_id: input.appId, platform: input.platform, error })
}

/** Validate + encrypt + upsert. Shared by the API-key PUT and the token upload PUT. */
async function storeBuildCredentials(c: Context, input: {
  appId: string
  platform: BuildPlatform
  mode: BuildCredentialsWriteMode
  incoming: unknown
  actor: AuditActor
  /** Runs after validation, right before the write (single-use upload token burn). */
  beforeWrite?: () => Promise<void>
}): Promise<BuildCredentialsWriteResponse> {
  const { appId, platform, mode, actor } = input
  let incoming: CredentialRecord
  try {
    incoming = parseCredentialRecord(input.incoming)
    assertStorableCredentialKeys(incoming)
  }
  catch (error) {
    asValidationError(error)
  }

  const keyring = getBuildCredentialsKeyring(c)
  const ownerOrg = await getAppOwnerOrg(c, appId)
  const [existing] = await loadStoredRows(c, appId, platform)

  let base: CredentialRecord = {}
  if (mode === 'merge' && existing) {
    try {
      base = withoutStoredReservedEnvKeys((await openBuildCredentials({ keyring, appId, platform, ciphertext: existing.ciphertext, keyVersion: existing.key_version })).credentials)
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Stored build credentials cannot be decrypted for merge', app_id: appId, platform, error: (error as Error)?.message })
      quickError(409, 'build_credentials_decrypt_failed', 'Existing stored credentials cannot be decrypted; use mode "replace"', { app_id: appId, platform }, undefined, { alert: false })
    }
  }

  let normalized: CredentialRecord
  try {
    normalized = normalizeCredentialValues(platform, { ...base, ...incoming })
  }
  catch (error) {
    asValidationError(error)
  }
  if (Object.keys(normalized).length === 0)
    invalid('credentials must contain at least one non-empty value')

  const sealed = await sealBuildCredentials({ secret: keyring.current, appId, platform, credentials: normalized })
  const summary = summarizeCredentials(platform, normalized)
  const now = new Date().toISOString()

  if (input.beforeWrite)
    await input.beforeWrite()

  const values = {
    app_id: appId,
    owner_org: ownerOrg,
    platform,
    ciphertext: sealed.ciphertext,
    key_version: sealed.keyVersion,
    summary: summary as unknown as Json,
    created_by: existing ? existing.created_by : actor.userId,
    updated_by: actor.userId,
    updated_at: now,
  }
  // A merge is built on the row it read: write it only if that row is unchanged, so two
  // overlapping merges cannot silently drop each other's keys.
  const { data: row, error } = mode === 'merge' && existing
    ? await supabaseAdmin(c)
        .from('app_build_credentials')
        .update(values)
        .eq('id', existing.id)
        .eq('updated_at', existing.updated_at)
        .select('id, updated_at')
        .maybeSingle()
    : await supabaseAdmin(c)
        .from('app_build_credentials')
        .upsert(values, { onConflict: 'app_id,platform' })
        .select('id, updated_at')
        .single()
  if (!error && !row && mode === 'merge' && existing)
    quickError(409, 'build_credentials_conflict', 'The stored credentials changed while merging; retry the upload', { app_id: appId, platform }, undefined, { alert: false })
  if (error || !row) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Build credentials upsert failed', app_id: appId, platform, error })
    quickError(503, 'database_unavailable', 'Cannot store build credentials')
  }

  cloudlog({ requestId: c.get('requestId'), message: 'Build credentials stored', app_id: appId, platform, mode, key_count: summary.keys.length, missing_count: summary.missing.length })
  await writeAuditLog(c, {
    orgId: ownerOrg,
    recordId: row.id,
    operation: existing ? 'UPDATE' : 'INSERT',
    actor,
    appId,
    platform,
    oldSummary: existing ? existing.summary : null,
    newSummary: summary as unknown as Json,
  })

  return { app_id: appId, platform, mode, updated_at: row.updated_at, summary }
}

function actorFromApikey(c: Context, apikey: ApikeyRow): AuditActor {
  const authKey = (c.get('auth')?.apikey as ApikeyRow | undefined) ?? apikey
  return { userId: apikey.user_id, apikeyId: authKey?.id ?? null, apikeyName: authKey?.name ?? null }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function getBuildCredentialsStatus(c: Context): Promise<Response> {
  const appId = parseAppId(c.req.query('app_id'))
  await requireAppPermission(c, READ_PERMISSION, appId)
  const rows = await loadStoredRows(c, appId)
  const platforms: BuildCredentialsPlatformStatus[] = PLATFORMS.map((platform) => {
    const row = rows.find(r => r.platform === platform)
    return row
      ? { platform, configured: true, created_at: row.created_at, updated_at: row.updated_at, summary: row.summary as unknown as BuildCredentialsSummary }
      : { platform, configured: false }
  })
  return c.json({ app_id: appId, platforms })
}

export async function putBuildCredentials(c: Context, apikey: ApikeyRow): Promise<Response> {
  const body = await readJsonBody(c)
  const appId = parseAppId(body.app_id)
  const platform = parsePlatform(body.platform)
  const mode = parseMode(body.mode)
  await requireAppPermission(c, WRITE_PERMISSION, appId)
  const result = await storeBuildCredentials(c, { appId, platform, mode, incoming: body.credentials, actor: actorFromApikey(c, apikey) })
  return c.json(result)
}

export async function deleteBuildCredentials(c: Context, apikey: ApikeyRow): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await readJsonBody(c)
  }
  catch {
    body = {}
  }
  const query = c.req.query()
  const appId = parseAppId(body.app_id ?? query.app_id)
  const platform = parsePlatform(body.platform ?? query.platform)
  await requireAppPermission(c, WRITE_PERMISSION, appId)

  const { data, error } = await supabaseAdmin(c)
    .from('app_build_credentials')
    .delete()
    .eq('app_id', appId)
    .eq('platform', platform)
    .select('id, owner_org, summary')
  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Build credentials delete failed', app_id: appId, platform, error })
    quickError(503, 'database_unavailable', 'Cannot delete build credentials')
  }
  const deleted = data?.[0]
  if (!deleted)
    quickError(404, 'build_credentials_not_found', 'No stored build credentials for this app and platform', { app_id: appId, platform }, undefined, { alert: false })

  cloudlog({ requestId: c.get('requestId'), message: 'Build credentials deleted', app_id: appId, platform })
  await writeAuditLog(c, {
    orgId: deleted.owner_org,
    recordId: deleted.id,
    operation: 'DELETE',
    actor: actorFromApikey(c, apikey),
    appId,
    platform,
    oldSummary: deleted.summary,
    newSummary: null,
  })
  return c.json({ status: 'ok', app_id: appId, platform, deleted: true })
}

export async function createBuildCredentialsUploadUrl(c: Context, apikey: ApikeyRow): Promise<Response> {
  const body = await readJsonBody(c)
  const appId = parseAppId(body.app_id)
  const platform = parsePlatform(body.platform)
  const mode = parseMode(body.mode)
  await requireAppPermission(c, WRITE_PERMISSION, appId)
  // Fail early (503) when storage is not configured instead of after the upload.
  getBuildCredentialsKeyring(c)

  const authKey = (c.get('auth')?.apikey as ApikeyRow | undefined) ?? apikey
  const exp = Math.floor(Date.now() / 1000) + BUILD_CREDENTIALS_UPLOAD_TTL_SECONDS
  const token = await createBuildCredentialsUploadToken(getBuildCredentialsUploadSecret(c), {
    app_id: appId,
    platform,
    mode,
    user_id: apikey.user_id,
    apikey_id: authKey.id,
    exp,
  })
  const baseUrl = getEnv(c, 'PUBLIC_URL') || 'https://api.capgo.app'
  const uploadUrl = `${baseUrl}/build/credentials/upload/${token}`
  cloudlog({ requestId: c.get('requestId'), message: 'Build credentials upload URL created', app_id: appId, platform, mode })
  return c.json({
    app_id: appId,
    platform,
    mode,
    method: 'PUT',
    upload_url: uploadUrl,
    content_type: 'application/json',
    max_bytes: BUILD_CREDENTIALS_MAX_BODY_BYTES,
    expires_at: new Date(exp * 1000).toISOString(),
    curl: `curl -fsS -X PUT -H 'Content-Type: application/json' --data-binary @credentials.json '${uploadUrl}'`,
  })
}

/**
 * Re-checks, at upload time, that the API key that minted the token still exists, is not
 * expired, belongs to the same user, and still holds the write permission on the app.
 * Mirrors rbac_check_permission_direct's API-key principal branch.
 */
async function assertUploadTokenStillAuthorized(c: Context, claims: BuildCredentialsUploadClaims): Promise<AuditActor> {
  let pgClient: Awaited<ReturnType<typeof getPgClient>> | undefined
  try {
    pgClient = await getPgClient(c)
    const result = await getDrizzleClient(pgClient).execute(sql`
      SELECT
        k.user_id::text AS user_id,
        k.name AS name,
        public.is_apikey_expired(k.expires_at) AS expired,
        public.rbac_has_permission(
          public.rbac_principal_apikey(),
          k.rbac_id,
          ${WRITE_PERMISSION},
          a.owner_org,
          a.app_id,
          NULL::bigint
        ) AS allowed
      FROM public.apikeys AS k
      JOIN public.apps AS a ON a.app_id = ${claims.app_id}
      WHERE k.id = ${claims.apikey_id}
      LIMIT 1
    `)
    const row = result.rows[0] as { user_id?: string, name?: string, expired?: boolean, allowed?: boolean } | undefined
    if (!row || row.user_id !== claims.user_id || row.expired === true || row.allowed !== true) {
      cloudlog({ requestId: c.get('requestId'), message: 'Build credentials upload token no longer authorized', app_id: claims.app_id, platform: claims.platform })
      quickError(403, 'permission_denied', `Capgo permission denied: you do not have ${WRITE_PERMISSION} for this app.`, { app_id: claims.app_id }, undefined, { alert: false })
    }
    return { userId: claims.user_id, apikeyId: claims.apikey_id, apikeyName: row.name ?? null }
  }
  catch (error) {
    if (error && typeof error === 'object' && 'status' in error)
      throw error
    cloudlogErr({ requestId: c.get('requestId'), message: 'Build credentials upload permission check failed', error: serializeError(error) })
    quickError(503, 'database_unavailable', 'Cannot verify upload permission')
  }
  finally {
    if (pgClient)
      closeClient(c, pgClient)
  }
}

/**
 * Burns the upload token (its signed nonce) atomically, so a URL works exactly once.
 * Called after validation, so a rejected file can be fixed and re-sent with the same URL.
 * Also prunes a bounded batch of expired entries (an expired token is refused by its exp anyway).
 */
async function consumeUploadToken(c: Context, claims: BuildCredentialsUploadClaims): Promise<void> {
  let pgClient: Awaited<ReturnType<typeof getPgClient>> | undefined
  let consumed = false
  try {
    pgClient = await getPgClient(c)
    const result = await getDrizzleClient(pgClient).execute(sql`
      WITH pruned AS (
        DELETE FROM public.build_credentials_upload_token_uses
        WHERE nonce IN (
          SELECT nonce FROM public.build_credentials_upload_token_uses
          WHERE expires_at < now()
          ORDER BY expires_at
          LIMIT 100
        )
      )
      INSERT INTO public.build_credentials_upload_token_uses (nonce, app_id, expires_at)
      VALUES (${claims.nonce}, ${claims.app_id}, to_timestamp(${claims.exp}))
      ON CONFLICT (nonce) DO NOTHING
      RETURNING nonce
    `)
    consumed = result.rows.length === 1
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Build credentials upload token consume failed', app_id: claims.app_id, error: serializeError(error) })
    quickError(503, 'database_unavailable', 'Cannot verify upload URL', {}, undefined, { alert: false })
  }
  finally {
    if (pgClient)
      closeClient(c, pgClient)
  }
  if (!consumed) {
    cloudlog({ requestId: c.get('requestId'), message: 'Build credentials upload token replayed', app_id: claims.app_id, platform: claims.platform })
    quickError(409, 'upload_url_used', 'This credentials upload URL was already used; request a new one', {}, undefined, { alert: false })
  }
}

export async function uploadBuildCredentialsWithToken(c: Context, token: string): Promise<Response> {
  const verification = await verifyBuildCredentialsUploadToken(getBuildCredentialsUploadSecret(c), token)
  if (!verification.ok) {
    quickError(401, verification.reason === 'expired' ? 'upload_url_expired' : 'invalid_upload_token', verification.reason === 'expired'
      ? 'This credentials upload URL has expired; request a new one'
      : 'Invalid credentials upload URL', {}, undefined, { alert: false })
  }
  const { claims } = verification
  // Read (and so consume) the body before any DB work: an error report can then never
  // re-read it, and on_error never copies /build/credentials bodies anyway.
  const body = await readJsonBody(c)
  const actor = await assertUploadTokenStillAuthorized(c, claims)
  const incoming = unwrapSavedCredentialsFile(body, claims.app_id, claims.platform)
  const result = await storeBuildCredentials(c, {
    appId: claims.app_id,
    platform: claims.platform,
    mode: claims.mode,
    incoming,
    actor,
    beforeWrite: () => consumeUploadToken(c, claims),
  })
  return c.json(result)
}

/**
 * Accepts the flat one-platform record, `{ "<platform>": {...} }`, or the whole CLI saved
 * credentials file `{ "<appId>": { "<platform>": {...} } }` (only this app/platform is kept;
 * everything else in the file is discarded and never stored).
 */
export function unwrapSavedCredentialsFile(body: Record<string, unknown>, appId: string, platform: BuildPlatform): unknown {
  const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  const appEntry = body[appId]
  if (isRecord(appEntry)) {
    if (isRecord(appEntry[platform]))
      return appEntry[platform]
    quickError(400, 'invalid_build_credentials', `The credentials file has no ${platform} credentials for ${appId}`, {}, undefined, { alert: false })
  }
  const platformEntry = body[platform]
  if (isRecord(platformEntry))
    return platformEntry
  return body
}
