import type { Context } from 'hono'
import type { Database } from '../../utils/supabase.types.ts'
import { HTTPException } from 'hono/http-exception'
import { emitBuildTransitionEvent } from '../../utils/build_tracking.ts'
import { simpleError } from '../../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../../utils/logging.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseAdmin, supabaseApikey } from '../../utils/supabase.ts'
import { getEnv } from '../../utils/utils.ts'
import { isNativeBuildConcurrencyLimitError, reserveNativeBuildSlot } from './concurrency.ts'

interface BuilderStartResponse {
  status: string
  logs_url?: string
  logs_token?: string
}

function encodeBase64Url(input: Uint8Array): string {
  let binary = ''
  for (const byte of input) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

async function signHs256Jwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const header = {
    alg: 'HS256',
    typ: 'JWT',
  }

  const encodedHeader = encodeBase64Url(encoder.encode(JSON.stringify(header)))
  const encodedPayload = encodeBase64Url(encoder.encode(JSON.stringify(payload)))
  const signingInput = `${encodedHeader}.${encodedPayload}`

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    false,
    ['sign'],
  )

  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput)),
  )

  return `${signingInput}.${encodeBase64Url(signature)}`
}

/**
 * Generate a JWT token for direct log stream access
 * Uses HMAC-SHA256 for signing
 */
async function generateLogStreamToken(
  jobId: string,
  userId: string,
  appId: string,
  jwtSecret: string,
): Promise<string> {
  const nowInSeconds = Math.floor(Date.now() / 1000)
  return signHs256Jwt({
    job_id: jobId,
    app_id: appId,
    iss: 'capgo',
    aud: 'build-logs',
    sub: userId,
    iat: nowInSeconds,
    exp: nowInSeconds + (4 * 60 * 60),
  }, jwtSecret)
}

function normalizeStartedBuildStatus(status?: string): string {
  return status && status.toLowerCase() !== 'pending' ? status : 'running'
}

async function markBuildAsFailed(
  c: Context,
  jobId: string,
  appId: string,
  errorMessage: string,
): Promise<void> {
  // Access was already checked before starting the build. This trusted backend
  // status write uses service role because API-key RLS must stay read-only here.
  //
  // Fetch the row first to capture the fields we need for the lifecycle event
  // (previousStatus for the CAS guard + platform/build_mode/owner_org/requested_by for the
  // payload). Without this, marking a build failed here would silently miss
  // the `Build Failed` transition event, leaving the lifecycle funnel
  // incomplete for the builder-rejection and outer-catch paths.
  const adminClient = supabaseAdmin(c)
  const { data: row, error: selectError } = await adminClient
    .from('build_requests')
    .select('status, platform, build_mode, owner_org, requested_by')
    .eq('builder_job_id', jobId)
    .eq('app_id', appId)
    .maybeSingle()

  if (selectError || !row) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to fetch build_request before marking as failed',
      job_id: jobId,
      error: selectError?.message ?? 'row not found',
    })
    // Best-effort: still attempt the unguarded update so the user-facing status
    // is correct even when we can't capture pre-transition context.
    await adminClient
      .from('build_requests')
      .update({
        status: 'failed',
        last_error: errorMessage,
        updated_at: new Date().toISOString(),
      })
      .eq('builder_job_id', jobId)
      .eq('app_id', appId)
    return
  }

  const previousStatus = row.status

  // Optimistic concurrency-control: only one writer wins the transition.
  // If another writer (cron, status poller, etc.) already advanced the row,
  // the affected-row set is empty and we skip both the log and the emission.
  const { data: updatedRows, error: updateError } = await adminClient
    .from('build_requests')
    .update({
      status: 'failed',
      last_error: errorMessage,
      updated_at: new Date().toISOString(),
    })
    .eq('builder_job_id', jobId)
    .eq('app_id', appId)
    .eq('status', previousStatus)
    .select('id')

  if (updateError) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to update build_requests status to failed',
      job_id: jobId,
      error: updateError,
    })
    return
  }

  if (updatedRows && updatedRows.length > 0) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Marked build_request as failed',
      job_id: jobId,
      error_message: errorMessage,
    })
    await emitBuildTransitionEvent(c, {
      previousStatus,
      effectiveStatus: 'failed',
      timeoutApplied: false,
      effectiveError: errorMessage,
      build: {
        app_id: appId,
        platform: row.platform,
        build_mode: row.build_mode,
        owner_org: row.owner_org,
        requested_by: row.requested_by,
      },
    })
  }
}

export async function startBuild(
  c: Context,
  jobId: string,
  appId: string,
  apikey: Database['public']['Tables']['apikeys']['Row'],
): Promise<Response> {
  let alreadyMarkedAsFailed = false
  const apikeyKey = apikey.key ?? c.get('capgkey') ?? apikey.key_hash ?? null

  try {
    if (!apikeyKey) {
      const errorMsg = 'No API key available to start build'
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Missing API key for start build',
        job_id: jobId,
        user_id: apikey.user_id,
      })
      throw simpleError('not_authorized', errorMsg)
    }

    // Bind jobId to appId under RLS before calling the builder.
    // This prevents cross-app access by mixing an allowed app_id with another app's jobId.
    const supabase = supabaseApikey(c, apikeyKey)

    // Security: Check if user has permission to manage builds for the supplied app
    // before validating builder job ownership.
    if (!(await checkPermission(c, 'app.build_native', { appId }))) {
      const errorMsg = 'You do not have permission to start builds for this app'
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Unauthorized start build',
        job_id: jobId,
        app_id: appId,
        user_id: apikey.user_id,
      })
      throw simpleError('unauthorized', errorMsg)
    }

    const { data: buildRequest, error: buildRequestError } = await supabase
      .from('build_requests')
      .select('id, app_id, owner_org, requested_by, status, platform, build_mode')
      .eq('builder_job_id', jobId)
      .eq('app_id', appId)
      .maybeSingle()

    if (buildRequestError) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Failed to fetch build_request for start build',
        job_id: jobId,
        error: buildRequestError.message,
      })
      throw simpleError('internal_error', 'Failed to fetch build request')
    }

    if (!buildRequest) {
      const errorMsg = 'You do not have permission to start builds for this app'
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Unauthorized start build (job/app mismatch or missing)',
        job_id: jobId,
        app_id: appId,
        user_id: apikey.user_id,
      })
      throw simpleError('unauthorized', errorMsg)
    }

    const boundAppId = appId

    try {
      await reserveNativeBuildSlot(c, {
        buildRequestId: buildRequest.id,
        orgId: buildRequest.owner_org,
        appId: boundAppId,
        jobId,
        userId: apikey.user_id,
      })
    }
    catch (error) {
      // Persist a customer-facing reason on the build row so the dashboard can
      // show the concurrency/upgrade message instead of leaving a stuck pending job.
      if (isNativeBuildConcurrencyLimitError(error)) {
        await markBuildAsFailed(c, jobId, boundAppId, error.message)
        alreadyMarkedAsFailed = true
      }
      throw error
    }

    cloudlog({
      requestId: c.get('requestId'),
      message: 'Start build request',
      job_id: jobId,
      app_id: boundAppId,
      user_id: apikey.user_id,
    })

    // Call builder to start the job
    const builderResponse = await fetch(`${getEnv(c, 'BUILDER_URL')}/jobs/${jobId}/start`, {
      method: 'POST',
      headers: {
        'x-api-key': getEnv(c, 'BUILDER_API_KEY'),
      },
    })

    if (!builderResponse.ok) {
      const errorText = await builderResponse.text()
      const errorMsg = `Failed to start build: ${errorText}`
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Builder start failed',
        job_id: jobId,
        status: builderResponse.status,
        error: errorText,
      })

      // Update build_requests to mark as failed
      await markBuildAsFailed(c, jobId, boundAppId, errorMsg)
      alreadyMarkedAsFailed = true
      throw simpleError('builder_error', errorMsg)
    }

    const builderJob = await builderResponse.json() as BuilderStartResponse
    const startedStatus = normalizeStartedBuildStatus(builderJob.status)

    cloudlog({
      requestId: c.get('requestId'),
      message: 'Build started',
      job_id: jobId,
      status: startedStatus,
      builder_status: builderJob.status,
    })

    // Update build_requests status to running. The builder response is trusted
    // backend data, and this write must not be exposed through API-key RLS.
    //
    // Optimistic concurrency-control (CAS) guard: `.eq('status', previousStatus)`
    // ensures only one writer wins when concurrent start requests race. The
    // `.select('id')` lets us detect whether this writer actually advanced the
    // row; if `updatedRows` is empty, another writer already moved the status
    // and emitted the transition event — skip emission to avoid double-firing.
    const previousStatus = buildRequest.status

    const { data: updatedRows, error: updateError } = await supabaseAdmin(c)
      .from('build_requests')
      .update({
        status: startedStatus,
        updated_at: new Date().toISOString(),
      })
      .eq('builder_job_id', jobId)
      .eq('app_id', boundAppId)
      .eq('status', previousStatus)
      .select('id')

    if (updateError) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Failed to update build_requests status to running',
        job_id: jobId,
        error: updateError.message,
      })
    }
    else if (updatedRows && updatedRows.length > 0) {
      await emitBuildTransitionEvent(c, {
        previousStatus,
        effectiveStatus: startedStatus,
        timeoutApplied: false,
        build: {
          app_id: buildRequest.app_id,
          platform: buildRequest.platform,
          build_mode: buildRequest.build_mode,
          owner_org: buildRequest.owner_org,
          requested_by: buildRequest.requested_by,
        },
      })
    }
    // else: another writer already advanced the status (or it never matched
    // previousStatus) — skip emission to avoid double-firing.

    // Generate JWT token for direct log stream access
    const jwtSecret = getEnv(c, 'JWT_SECRET')
    const publicUrl = getEnv(c, 'PUBLIC_URL') || 'https://api.capgo.app'

    let logsUrl: string | undefined
    let logsToken: string | undefined

    if (jwtSecret) {
      try {
        // NOTE: The `/build_logs_direct/:jobId` endpoint is **not** implemented in this
        // backend. It is provided by the external Capgo Builder worker/service.
        // The JWT generated here is consumed and verified by that external service
        // (using a shared secret compatible with `JWT_SECRET`) to:
        //   - Authorize access to live build logs for the given jobId/appId/user
        //   - Stream logs directly to the CLI without going through this API as a proxy
        // If the direct URL and token are not provided, the CLI fails to get the logs of the build.
        logsToken = await generateLogStreamToken(jobId, apikey.user_id, boundAppId, jwtSecret)
        logsUrl = `${publicUrl}/build_logs_direct/${jobId}`

        cloudlog({
          requestId: c.get('requestId'),
          message: 'Generated log stream token for direct access',
          job_id: jobId,
          logs_url: logsUrl,
        })
      }
      catch (tokenError) {
        // Log error but don't fail the request - CLI can fall back to proxy
        cloudlogErr({
          requestId: c.get('requestId'),
          message: 'Failed to generate log stream token',
          job_id: jobId,
          error: tokenError instanceof Error ? tokenError.message : String(tokenError),
        })
      }
    }
    else {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'JWT_SECRET not configured, skipping direct log stream token',
        job_id: jobId,
      })
    }

    return c.json({
      job_id: jobId,
      status: startedStatus,
      ...(logsUrl && logsToken ? { logs_url: logsUrl, logs_token: logsToken } : {}),
    }, 200)
  }
  catch (error) {
    // Mark build as failed for any unexpected error (but only if not already marked)
    if (!alreadyMarkedAsFailed && apikeyKey && !(error instanceof HTTPException)) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      await markBuildAsFailed(c, jobId, appId, errorMsg)
    }
    throw error
  }
}
