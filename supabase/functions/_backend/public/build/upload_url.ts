import type { Context } from 'hono'
import type { Database } from '../../utils/supabase.types.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../../utils/logging.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseApikey } from '../../utils/supabase.ts'
import { getEnv } from '../../utils/utils.ts'
import { assertBuildUploadWindowOpen } from './upload.ts'
import { ensureStoredCredentialsPermission } from './stored_credentials_access.ts'

interface BuilderInputUploadUrl {
  upload_url: string
  method?: string
  expires_at: string
  max_bytes?: number
}

/**
 * Signed single-PUT alternative to the TUS proxy, for clients without a TUS client
 * (e.g. an AI agent using the hosted MCP with only curl). Same gates as the TUS proxy;
 * the bytes go straight to the builder, which stores them at the job's artifact key.
 */
export async function getBuildUploadUrl(
  c: Context,
  jobId: string,
  appId: string,
  apikey: Database['public']['Tables']['apikeys']['Row'],
): Promise<Response> {
  if (!(await checkPermission(c, 'app.build_native', { appId })))
    throw simpleError('unauthorized', 'You do not have permission to upload a build for this app', { app_id: appId })

  const { data: buildRequest, error } = await supabaseApikey(c, apikey.key)
    .from('build_requests')
    .select('app_id, status, upload_expires_at, uses_stored_credentials')
    .eq('builder_job_id', jobId)
    .eq('app_id', appId)
    .single()
  if (error || !buildRequest)
    throw simpleError('not_found', 'Build request not found', { job_id: jobId })

  assertBuildUploadWindowOpen(c, jobId, buildRequest)
  // The uploaded project runs with the stored signing secrets: same right as requesting it.
  if (buildRequest.uses_stored_credentials)
    await ensureStoredCredentialsPermission(c, appId, apikey.user_id)

  const builderUrl = getEnv(c, 'BUILDER_URL')
  const builderApiKey = getEnv(c, 'BUILDER_API_KEY')
  if (!builderUrl || !builderApiKey)
    throw quickError(503, 'service_unavailable', 'Builder service not configured')

  const uploadDeadline = buildRequest.upload_expires_at ? new Date(buildRequest.upload_expires_at) : null
  if (!uploadDeadline || Number.isNaN(uploadDeadline.getTime()))
    throw quickError(403, 'upload_expired', 'Upload window has expired', {}, undefined, { alert: false })

  // The builder caps the signed URL at this deadline, so the URL itself stops working
  // when the build's upload window closes (not only the expires_at we report).
  const response = await fetch(`${builderUrl}/jobs/${encodeURIComponent(jobId)}/input-upload-url`, {
    method: 'POST',
    headers: { 'x-api-key': builderApiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ expires_at: uploadDeadline.toISOString() }),
  })
  if (!response.ok) {
    const errorText = await response.text()
    cloudlogErr({ requestId: c.get('requestId'), message: 'Builder input upload url failed', job_id: jobId, status: response.status, error: errorText })
    throw simpleError('builder_error', 'Failed to get a build upload URL', { status: response.status })
  }
  const signed = await response.json() as BuilderInputUploadUrl

  // The builder already caps the URL at uploadDeadline; min() keeps the report correct
  // against a builder that predates the expires_at body field.
  const signedExpiry = Date.parse(signed.expires_at)
  const expiresAt = new Date(Number.isFinite(signedExpiry) ? Math.min(signedExpiry, uploadDeadline.getTime()) : uploadDeadline.getTime()).toISOString()

  cloudlog({ requestId: c.get('requestId'), message: 'Build input upload url issued', job_id: jobId, app_id: appId })
  return c.json({
    job_id: jobId,
    upload_url: signed.upload_url,
    method: 'PUT',
    headers: { 'Content-Type': 'application/zip' },
    expires_at: expiresAt,
    max_bytes: signed.max_bytes,
  })
}
