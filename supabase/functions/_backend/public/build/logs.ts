import type { Context } from 'hono'
import type { Database } from '../../utils/supabase.types.ts'
import { simpleError } from '../../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../../utils/logging.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseApikey } from '../../utils/supabase.ts'
import { getEnv } from '../../utils/utils.ts'

async function cancelBuildOnDisconnect(
  builderUrl: string,
  builderApiKey: string,
  jobId: string,
  appId: string,
  requestId: string,
): Promise<void> {
  try {
    cloudlog({
      requestId,
      message: 'Client disconnected, cancelling build',
      job_id: jobId,
      app_id: appId,
    })

    const response = await fetch(`${builderUrl}/jobs/${jobId}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': builderApiKey,
      },
      body: JSON.stringify({ app_id: appId }),
    })

    if (response.ok) {
      cloudlog({
        requestId,
        message: 'Build cancelled successfully after client disconnect',
        job_id: jobId,
      })
    }
    else {
      const errorText = await response.text()
      cloudlogErr({
        requestId,
        message: 'Failed to cancel build after client disconnect',
        job_id: jobId,
        status: response.status,
        error: errorText,
      })
    }
  }
  catch (err) {
    cloudlogErr({
      requestId,
      message: 'Error cancelling build after client disconnect',
      job_id: jobId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function streamBuildLogs(
  c: Context,
  jobId: string,
  appId: string,
  apikey: Database['public']['Tables']['apikeys']['Row'],
): Promise<Response> {
  // DEPRECATION: This proxy endpoint is deprecated in favor of direct SSE streaming.
  // New CLI versions receive logs_url and logs_token from /build/start and connect directly
  // to the CF Worker. This proxy is kept for backwards compatibility with older CLI versions.
  cloudlog({
    requestId: c.get('requestId'),
    message: 'Build logs stream request (deprecated proxy - use direct SSE)',
    job_id: jobId,
    app_id: appId,
    user_id: apikey.user_id,
  })

  // Bind jobId to appId under RLS before calling the builder.
  // This prevents cross-app access by mixing an allowed app_id with another app's jobId.
  const supabase = supabaseApikey(c, apikey.key)
  const { data: buildRequest, error: buildRequestError } = await supabase
    .from('build_requests')
    .select('app_id')
    .eq('builder_job_id', jobId)
    .maybeSingle()

  if (buildRequestError) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to fetch build_request for logs',
      job_id: jobId,
      error: buildRequestError.message,
    })
    throw simpleError('internal_error', 'Failed to fetch build request')
  }

  if (buildRequest?.app_id !== appId) {
    // Treat missing row and mismatched app_id as unauthorized to avoid leaking job existence.
    throw simpleError('unauthorized', 'You do not have permission to view logs for this app')
  }

  // Security: Check if user has read access to this app (auth context set by middlewareKey)
  if (!(await checkPermission(c, 'app.read_logs', { appId: buildRequest.app_id }))) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Unauthorized logs request',
      job_id: jobId,
      app_id: appId,
      user_id: apikey.user_id,
    })
    throw simpleError('unauthorized', 'You do not have permission to view logs for this app')
  }

  // Proxy SSE stream from builder.capgo.app
  const builderUrl = getEnv(c, 'BUILDER_URL')
  const builderApiKey = getEnv(c, 'BUILDER_API_KEY')

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Connecting to builder for logs',
    job_id: jobId,
    builder_url: builderUrl ? `${builderUrl}/jobs/${jobId}/logs` : 'BUILDER_URL not set',
    has_api_key: !!builderApiKey,
  })

  if (!builderUrl || !builderApiKey) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Builder config missing',
      job_id: jobId,
      has_builder_url: !!builderUrl,
      has_builder_api_key: !!builderApiKey,
    })
    throw simpleError('config_error', 'Builder service not configured')
  }

  const builderResponse = await fetch(`${builderUrl}/jobs/${jobId}/logs`, {
    method: 'GET',
    headers: {
      'x-api-key': builderApiKey,
    },
  })

  if (!builderResponse.ok) {
    const errorText = await builderResponse.text()
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Builder logs fetch failed',
      job_id: jobId,
      status: builderResponse.status,
      error: errorText,
    })
    throw simpleError('builder_error', `Failed to get build logs: ${errorText}`)
  }

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Streaming build logs',
    job_id: jobId,
  })

  const requestId = c.get('requestId')
  // Security: align disconnect-triggered cancellation with the explicit cancel endpoint.
  let canCancelOnDisconnect = false
  try {
    canCancelOnDisconnect = await checkPermission(c, 'app.build_native', { appId: buildRequest.app_id })
  }
  catch (err) {
    cloudlogErr({
      requestId,
      message: 'Failed to verify cancel permission for build logs disconnect',
      job_id: jobId,
      app_id: buildRequest.app_id,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  if (canCancelOnDisconnect) {
    const cancelOnAbort = () => {
      // Fire and forget - cancel the build when an authorized client disconnects.
      cancelBuildOnDisconnect(builderUrl, builderApiKey, jobId, buildRequest.app_id, requestId)
    }

    if (c.req.raw.signal.aborted) {
      cancelOnAbort()
    }
    else {
      c.req.raw.signal.addEventListener('abort', cancelOnAbort, { once: true })
    }
  }

  // Directly return the builder's response body as an SSE stream
  // The builder already returns proper SSE format with Content-Type: text/event-stream
  return new Response(builderResponse.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    },
  })
}
