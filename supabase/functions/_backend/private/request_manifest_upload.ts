import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { ManifestUploadRequest, ManifestUploadResponse } from '../utils/manifest_upload.ts'
import { eq } from 'drizzle-orm'
import { getRuntimeKey } from 'hono/adapter'
import { HTTPException } from 'hono/http-exception'
import { Hono } from 'hono/tiny'
import { quickError } from '../utils/hono.ts'
import { middlewareKey } from '../utils/hono_middleware.ts'
import { cloudlog } from '../utils/logging.ts'
import { createManifestUploadResponse, ManifestUploadRequestError, parseManifestUploadRequestBody, resolveManifestUploadPublicBaseUrl, validateManifestUploadRequest } from '../utils/manifest_upload.ts'
import { closeClient, getAppByIdPg, getDrizzleClient, getPgClient, logPgError } from '../utils/pg.ts'
import * as schema from '../utils/postgres_schema.ts'
import { onPremiseAppResponse } from '../utils/rateLimitInfo.ts'
import { checkPermissionPg } from '../utils/rbac.ts'
import { getEnv } from '../utils/utils.ts'

export const app = new Hono<MiddlewareKeyVariables>()
const ATTACHMENT_PLAN_LIMIT: Array<'mau' | 'bandwidth' | 'storage'> = ['mau', 'bandwidth', 'storage']
const encoder = new TextEncoder()

function manifestUploadError(error: ManifestUploadRequestError): never {
  return quickError(error.status, error.code, error.message, error.moreInfo)
}

function manifestUploadPublicUrl(c: Parameters<typeof getEnv>[0]): string {
  const configured = getEnv(c, 'FILES_PUBLIC_URL') || getEnv(c, 'PUBLIC_URL')
  if (configured || getRuntimeKey() === 'workerd')
    return configured

  const supabaseUrl = getEnv(c, 'SUPABASE_URL').replace(/\/+$/, '')
  return supabaseUrl ? `${supabaseUrl}/functions/v1` : ''
}

app.post('/', middlewareKey({ usePostgres: true, readOnly: false, rateLimitScope: 'upload' }), async (c) => {
  const startedAt = Date.now()
  let request: ManifestUploadRequest
  let requestBytes = 0
  try {
    const parsed = await parseManifestUploadRequestBody(c.req.raw)
    requestBytes = parsed.byteLength
    request = validateManifestUploadRequest(parsed.body)
  }
  catch (error) {
    if (error instanceof ManifestUploadRequestError)
      return manifestUploadError(error)
    throw error
  }

  const auth = c.get('auth')
  if (!auth?.userId)
    return quickError(401, 'not_authorized', 'Not authorized')

  const pgClient = getPgClient(c, false)
  try {
    const drizzleClient = getDrizzleClient(pgClient)
    const [version] = await drizzleClient
      .select({
        id: schema.app_versions.id,
        appId: schema.app_versions.app_id,
        deleted: schema.app_versions.deleted,
        deletedAt: schema.app_versions.deleted_at,
        storageProvider: schema.app_versions.storage_provider,
        sessionKey: schema.app_versions.session_key,
      })
      .from(schema.app_versions)
      .where(eq(schema.app_versions.id, request.version_id))
      .limit(1)

    const apikey = c.get('capgkey') ?? null
    if (!version || !(await checkPermissionPg(c, 'app.upload_bundle', { appId: version.appId }, drizzleClient, auth.userId, apikey)))
      return quickError(404, 'error_version_not_found', 'Version not found')

    const appPlan = await getAppByIdPg(c, version.appId, drizzleClient, ATTACHMENT_PLAN_LIMIT)
    if (!appPlan)
      return quickError(503, 'upstream_unavailable', 'App plan state temporarily unavailable')
    if (!appPlan.plan_valid)
      return onPremiseAppResponse(c)

    if (version.deleted || version.deletedAt || version.storageProvider !== 'r2-direct') {
      return quickError(409, 'error_version_not_uploadable', 'Version is not uploadable', {
        storage_provider: version.storageProvider,
      })
    }
    if (request.delta_encryption.enabled && !version.sessionKey) {
      return quickError(409, 'error_delta_encryption_invalid', 'Delta encryption configuration is invalid', {
        field: 'delta_encryption.enabled',
      })
    }

    const publicBaseUrl = resolveManifestUploadPublicBaseUrl(c.req.url, manifestUploadPublicUrl(c))
    const capabilitySecret = getEnv(c, 'MANIFEST_UPLOAD_CAPABILITY_SECRET')
    if (capabilitySecret && capabilitySecret === getEnv(c, 'MANIFEST_SIZE_RECEIPT_SECRET'))
      return quickError(503, 'upload_authorization_unavailable', 'Upload authorization is unavailable')
    let response: ManifestUploadResponse
    try {
      response = await createManifestUploadResponse(request, {
        ownerOrg: appPlan.owner_org,
        appId: version.appId,
        sessionKey: version.sessionKey,
        secret: capabilitySecret,
        keyId: getEnv(c, 'MANIFEST_UPLOAD_CAPABILITY_KEY_ID'),
        publicBaseUrl,
      })
    }
    catch (error) {
      if (error instanceof ManifestUploadRequestError)
        return manifestUploadError(error)
      throw error
    }

    cloudlog({
      requestId: c.get('requestId'),
      message: 'request_manifest_upload done',
      version_id: request.version_id,
      entry_count: request.entries.length,
      request_bytes: requestBytes,
      response_bytes: encoder.encode(JSON.stringify(response)).byteLength,
      elapsed_ms: Date.now() - startedAt,
    })
    return c.json(response)
  }
  catch (error) {
    if (error instanceof HTTPException)
      throw error
    logPgError(c, 'request_manifest_upload', error)
    return quickError(503, 'upstream_unavailable', 'Upload authorization state temporarily unavailable')
  }
  finally {
    await closeClient(c, pgClient)
  }
})
