import type { Context } from 'hono'
import type { Database } from '../../utils/supabase.types.ts'
import { HTTPException } from 'hono/http-exception'
import { TERMINAL_BUILD_STATUSES } from '../../utils/build_timeout.ts'
import { emitBuildTransitionEvent } from '../../utils/build_tracking.ts'
import { persistBuilderBuildOutcome } from '../../utils/builder_onboarding_checklist.ts'
import { simpleError } from '../../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../../utils/logging.ts'
import type { PgClient } from '../../utils/pg.ts'
import { closeClient, getPgClient } from '../../utils/pg.ts'
import { apikeyPrincipal, queryJson, withRlsContext } from '../../utils/pg_rls.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { getEnv } from '../../utils/utils.ts'
import { isNativeBuildConcurrencyLimitError, reserveNativeBuildSlot } from './concurrency.ts'
import { ensureStoredCredentialsPermission } from './stored_credentials_access.ts'

interface BuilderStartResponse {
  status: string
  logs_url?: string
  logs_token?: string
}

function encodeBase64Url(input: Uint8Array): string {
  let binary = ''
  for (const byte of input) {
    binary += String.fromCodePoint(byte)
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
  let pg: PgClient
  try {
    pg = await getPgClient(c)
  }
  catch (error) {
    // supabase-js never threw here: DB failures were logged and swallowed.
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to update build_requests status to failed',
      job_id: jobId,
      error,
    })
    return
  }
  try {
    await markBuildAsFailedWithClient(c, pg, jobId, appId, errorMessage)
  }
  finally {
    closeClient(c, pg)
  }
}

type FailedBuildRow = Pick<Database['public']['Tables']['build_requests']['Row'], 'status' | 'platform' | 'build_mode' | 'owner_org' | 'requested_by'>

async function markBuildAsFailedWithClient(
  c: Context,
  pg: PgClient,
  jobId: string,
  appId: string,
  errorMessage: string,
): Promise<void> {
  let row: FailedBuildRow | null = null
  let selectError: Error | null = null
  try {
    const rows = await queryJson<FailedBuildRow>(
      pg,
      `SELECT status, platform, build_mode, owner_org, requested_by
      FROM public.build_requests
      WHERE builder_job_id = $1 AND app_id = $2
      LIMIT 2`,
      [jobId, appId],
    )
    // maybeSingle(): more than one row was an error under PostgREST
    if (rows.length > 1)
      throw new Error('JSON object requested, multiple (or no) rows returned')
    row = rows[0] ?? null
  }
  catch (error) {
    selectError = error instanceof Error ? error : new Error(String(error))
  }

  if (selectError || !row) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to fetch build_request before marking as failed',
      job_id: jobId,
      error: selectError?.message ?? 'row not found',
    })
    // Best-effort: still attempt the unguarded update so the user-facing status
    // is correct even when we can't capture pre-transition context.
    let platform: string | undefined
    let updateError: unknown = null
    try {
      const result = await pg.query<{ platform: string }>(
        `UPDATE public.build_requests
        SET status = 'failed', last_error = $3, updated_at = $4
        WHERE builder_job_id = $1 AND app_id = $2 AND NOT (status = ANY($5::text[]))
        RETURNING platform`,
        [jobId, appId, errorMessage, new Date().toISOString(), [...TERMINAL_BUILD_STATUSES]],
      )
      platform = result.rows[0]?.platform
    }
    catch (error) {
      updateError = error
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Failed to update build_requests status to failed',
        job_id: jobId,
        error,
      })
    }
    if (!updateError && (platform === 'ios' || platform === 'android'))
      await persistBuilderBuildOutcome(c, { appId, platform, status: 'failed' })
    return
  }

  const previousStatus = row.status

  // Optimistic concurrency-control: only one writer wins the transition.
  // If another writer (cron, status poller, etc.) already advanced the row,
  // the affected-row set is empty and we skip both the log and the emission.
  let updatedCount: number
  try {
    const result = await pg.query(
      `UPDATE public.build_requests
      SET status = 'failed', last_error = $3, updated_at = $4
      WHERE builder_job_id = $1 AND app_id = $2 AND status = $5
      RETURNING id`,
      [jobId, appId, errorMessage, new Date().toISOString(), previousStatus],
    )
    updatedCount = result.rowCount ?? 0
  }
  catch (updateError) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to update build_requests status to failed',
      job_id: jobId,
      error: updateError,
    })
    return
  }

  if (updatedCount > 0) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Marked build_request as failed',
      job_id: jobId,
      error_message: errorMessage,
    })
    if (row.platform === 'ios' || row.platform === 'android')
      await persistBuilderBuildOutcome(c, { appId, platform: row.platform, status: 'failed' })
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
    const principal = apikeyPrincipal(c, apikeyKey)

    // Security: Check if user has permission to manage builds for the supplied app
    // before validating builder job ownership.
    if (!(await checkPermission(c, 'app.build_native', { appId }))) {
      const errorMsg = 'Capgo permission denied: you do not have app.build_native to start builds for this app.'
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Unauthorized start build',
        job_id: jobId,
        app_id: appId,
        user_id: apikey.user_id,
      })
      throw simpleError('unauthorized', errorMsg)
    }

    type StartBuildRow = Pick<Database['public']['Tables']['build_requests']['Row'], 'id' | 'app_id' | 'owner_org' | 'requested_by' | 'status' | 'platform' | 'build_mode' | 'uses_stored_credentials'>
    let buildRequest: StartBuildRow | null
    try {
      const rows = await withRlsContext(c, principal, client => queryJson<StartBuildRow>(
        client,
        `SELECT id, app_id, owner_org, requested_by, status, platform, build_mode, uses_stored_credentials
        FROM public.build_requests
        WHERE builder_job_id = $1 AND app_id = $2
        LIMIT 2`,
        [jobId, appId],
      ))
      // maybeSingle(): more than one row was an error under PostgREST
      if (rows.length > 1)
        throw new Error('JSON object requested, multiple (or no) rows returned')
      buildRequest = rows[0] ?? null
    }
    catch (buildRequestError) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Failed to fetch build_request for start build',
        job_id: jobId,
        error: buildRequestError instanceof Error ? buildRequestError.message : String(buildRequestError),
      })
      throw simpleError('internal_error', 'Failed to fetch build request')
    }

    if (!buildRequest) {
      const errorMsg = 'Build request not found for this app and job.'
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Unauthorized start build (job/app mismatch or missing)',
        job_id: jobId,
        app_id: appId,
        user_id: apikey.user_id,
      })
      throw simpleError('unauthorized', errorMsg)
    }

    // Starting runs the uploaded project with the stored signing secrets.
    if (buildRequest.uses_stored_credentials)
      await ensureStoredCredentialsPermission(c, appId, apikey.user_id)

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

    let updatedCount = 0
    let updateFailed = false
    let pg: PgClient | null = null
    try {
      pg = await getPgClient(c)
      // started_at is set later from the builder-reported run start (status/reconcile).
      const result = await pg.query(
        `UPDATE public.build_requests
        SET status = $4, updated_at = $5
        WHERE builder_job_id = $1 AND app_id = $2 AND status = $3
        RETURNING id`,
        [jobId, boundAppId, previousStatus, startedStatus, new Date().toISOString()],
      )
      updatedCount = result.rowCount ?? 0
    }
    catch (updateError) {
      updateFailed = true
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Failed to update build_requests status to running',
        job_id: jobId,
        error: updateError instanceof Error ? updateError.message : String(updateError),
      })
    }
    finally {
      if (pg)
        closeClient(c, pg)
    }

    if (!updateFailed && updatedCount > 0) {
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
