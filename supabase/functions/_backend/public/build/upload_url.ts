import type { Context } from 'hono'
import type { Database } from '../../utils/supabase.types.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../../utils/logging.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseApikey } from '../../utils/supabase.ts'
import { getEnv } from '../../utils/utils.ts'
import { assertBuildUploadWindowOpen } from './upload.ts'

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
  const builderUrl = getEnv(c, 'BUILDER_URL')
  const builderApiKey = getEnv(c, 'BUILDER_API_KEY')
  if (!builderUrl || !builderApiKey)
    throw quickError(503, 'service_unavailable', 'Builder service not configured')

  if (!(await checkPermission(c, 'app.build_native', { appId })))
    throw simpleError('unauthorized', 'You do not have permission to upload a build for this app', { app_id: appId })

  const { data: buildRequest, error } = await supabaseApikey(c, apikey.key)
    .from('build_requests')
    .select('app_id, status, upload_expires_at')
    .eq('builder_job_id', jobId)
    .eq('app_id', appId)
    .single()
  if (error || !buildRequest)
    throw simpleError('not_found', 'Build request not found', { job_id: jobId })

  assertBuildUploadWindowOpen(c, jobId, buildRequest)

  const response = await fetch(`${builderUrl}/jobs/${encodeURIComponent(jobId)}/input-upload-url`, {
    method: 'POST',
    headers: { 'x-api-key': builderApiKey, 'content-type': 'application/json' },
    body: '{}',
  })
  if (!response.ok) {
    const errorText = await response.text()
    cloudlogErr({ requestId: c.get('requestId'), message: 'Builder input upload url failed', job_id: jobId, status: response.status, error: errorText })
    throw simpleError('builder_error', 'Failed to get a build upload URL', { status: response.status })
  }
  const signed = await response.json() as BuilderInputUploadUrl

  // Never let the signed URL outlive the build's own upload window.
  const expiresAt = new Date(Math.min(new Date(signed.expires_at).getTime(), new Date(buildRequest.upload_expires_at!).getTime())).toISOString()

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
