import type { Context } from 'hono'
import type { Database } from '../../utils/supabase.types.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { cloudlog, cloudlogErr, serializeError } from '../../utils/logging.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseAdmin, supabaseApikey } from '../../utils/supabase.ts'
import { sendEventToTracking } from '../../utils/tracking.ts'
import { getEnv } from '../../utils/utils.ts'
import { assertNativeBuildConcurrencyAvailable, getPlansUpgradeUrl } from './concurrency.ts'

export interface RequestBuildBody {
  app_id: string
  platform: 'ios' | 'android'
  build_mode?: 'release' | 'debug'
  build_config?: Record<string, any>
  /** @deprecated Use build_credentials instead. Rejected at runtime. */
  credentials?: Record<string, string>
  build_options?: Record<string, unknown>
  build_credentials?: Record<string, string>
}

export interface RequestBuildResponse {
  build_request_id: string
  job_id: string
  upload_session_key: string
  upload_path: string
  upload_url: string // This will be the Capgo proxy URL, not the builder URL directly
  upload_expires_at: string
  status: string
}

interface BuilderJobResponse {
  jobId: string
  uploadUrl: string
  status: string
}

interface ValidBuildRequestBody {
  app_id: string
  platform: 'ios' | 'android'
  build_mode: 'release' | 'debug'
  build_config: Record<string, any>
  build_options: Record<string, unknown>
  build_credentials: Record<string, string>
}

function throwBuilderUnavailable(message: string, moreInfo: Record<string, unknown> = {}, cause?: unknown): never {
  throw quickError(503, 'service_unavailable', message, moreInfo, cause, { alert: false })
}

/**
 * Construct the JSON body forwarded to the builder's POST /jobs endpoint.
 * Extracted for testability — the handler calls this, and unit tests assert the shape.
 */
export function buildBuilderPayload(input: {
  orgId: string
  actorUserId: string
  uploadPath: string
  platform: string
  buildOptions: Record<string, unknown>
  buildCredentials: Record<string, string>
}) {
  const buildOptions = { ...input.buildOptions }
  delete buildOptions.timeoutSeconds

  return {
    // userId carries the org_id (anonymized owner) — kept for backwards compat.
    userId: input.orgId,
    // actorUserId is the human user who triggered the build (apikey.user_id). The builder
    // uses it as the PostHog distinct_id so its build events join this same person.
    actorUserId: input.actorUserId,
    artifactKey: input.uploadPath,
    fastlane: { lane: input.platform },
    buildOptions,
    buildCredentials: input.buildCredentials,
  }
}

/** Exported for unit tests — follows bundleUsageTestUtils pattern. */
export const builderPayloadTestUtils = { buildBuilderPayload }

function hasLegacyCredentials(body: RequestBuildBody): boolean {
  const credentials = Reflect.get(body, 'credentials')
  return typeof credentials === 'object' && credentials !== null && Object.keys(credentials).length > 0
}

function validateBuildRequestBody(c: Context, body: RequestBuildBody, userId: string): ValidBuildRequestBody {
  const {
    app_id,
    platform,
    build_mode = 'release',
    build_config = {},
    build_options = {},
    build_credentials = {},
  } = body

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Build request received',
    app_id,
    platform,
    user_id: userId,
  })

  // Reject deprecated `credentials` field — old CLIs must upgrade
  if (hasLegacyCredentials(body)) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Deprecated credentials field received',
      app_id,
      platform,
    })
    throw simpleError(
      'invalid_parameter',
      '`credentials` field is deprecated. Please update your CLI and use `build_credentials` instead.',
    )
  }

  // Validate required fields
  if (!app_id) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Missing app_id' })
    throw simpleError('missing_parameter', 'app_id is required')
  }

  if (!platform) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Missing platform' })
    throw simpleError('missing_parameter', 'platform is required')
  }

  if (!['ios', 'android'].includes(platform)) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Invalid platform', platform })
    throw simpleError('invalid_parameter', 'platform must be ios or android')
  }

  if (build_mode && !['release', 'debug'].includes(build_mode)) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Invalid build_mode', build_mode })
    throw simpleError('invalid_parameter', 'build_mode must be release or debug')
  }

  if (build_config && typeof build_config !== 'object') {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Invalid build_config type' })
    throw simpleError('invalid_parameter', 'build_config must be an object')
  }

  return {
    app_id,
    platform: platform as 'ios' | 'android',
    build_mode: build_mode as 'release' | 'debug',
    build_config: build_config as Record<string, any>,
    build_options,
    build_credentials,
  }
}

async function ensureBuildPermission(c: Context, appId: string, userId: string) {
  // Check if the user has permission to request builds (auth context set by middlewareKey)
  if (!(await checkPermission(c, 'app.build_native', { appId }))) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Unauthorized build request',
      app_id: appId,
      user_id: userId,
    })
    throw simpleError('unauthorized', 'You do not have permission to request builds for this app')
  }
}

async function getBuildOwnerOrg(c: Context, supabase: ReturnType<typeof supabaseApikey>, appId: string): Promise<string> {
  // Get org_id for the app to use as anonymized user ID
  const { data: app, error: appError } = await supabase
    .from('apps')
    .select('owner_org')
    .eq('app_id', appId)
    .single()

  if (appError || !app) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'App not found', app_id: appId, error: appError })
    throw simpleError('not_found', 'App not found')
  }

  return app.owner_org
}

async function ensureBuildTimePlanAllowed(c: Context, supabase: ReturnType<typeof supabaseApikey>, orgId: string, appId: string) {
  // Native builds consume build-time credits; check that metric before creating a builder job.
  const buildTimePlanArgs = { orgid: orgId, actions: ['build_time'], appid: appId } as never
  const { data: buildTimeAllowed, error: buildTimePlanError } = await supabase.rpc('is_allowed_action_org_action', buildTimePlanArgs)
  if (buildTimePlanError) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Cannot validate native build plan',
      org_id: orgId,
      app_id: appId,
      error: buildTimePlanError,
    })
    throw quickError(503, 'cannot_validate_build_plan', 'Cannot validate native build plan', { app_id: appId, org_id: orgId })
  }

  if (!buildTimeAllowed) {
    const upgradeUrl = getPlansUpgradeUrl(c)
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Native build blocked by build time plan limit',
      org_id: orgId,
      app_id: appId,
    })
    throw quickError(429, 'need_plan_upgrade', `Cannot request native build, upgrade plan to continue to build: ${upgradeUrl}`, {
      app_id: appId,
      org_id: orgId,
      reason: 'build_time',
      upgrade_url: upgradeUrl,
    }, undefined, { alert: false })
  }
}

function getBuilderConfig(c: Context) {
  const builderUrl = getEnv(c, 'BUILDER_URL')
  const builderApiKey = getEnv(c, 'BUILDER_API_KEY')

  if (!builderUrl || !builderApiKey) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Builder API not configured',
      builder_url_configured: !!builderUrl,
      builder_api_key_configured: !!builderApiKey,
    })
    throwBuilderUnavailable('Build service unavailable (builder not configured)')
  }

  return { builderUrl, builderApiKey }
}

async function createBuilderJob(c: Context, input: {
  builderUrl: string
  builderApiKey: string
  orgId: string
  actorUserId: string
  appId: string
  platform: 'ios' | 'android'
  uploadPath: string
  buildOptions: Record<string, unknown>
  buildCredentials: Record<string, string>
}): Promise<BuilderJobResponse> {
  const { builderUrl, builderApiKey, orgId, actorUserId, appId, platform, uploadPath, buildOptions, buildCredentials } = input
  cloudlog({
    requestId: c.get('requestId'),
    message: 'Calling builder API',
    builder_url: builderUrl,
    org_id: orgId,
    app_id: appId,
    platform,
    artifact_key: uploadPath,
  })

  try {
    const builderResponse = await fetch(`${builderUrl}/jobs`, {
      method: 'POST',
      headers: {
        'x-api-key': builderApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildBuilderPayload({
        orgId,
        actorUserId,
        uploadPath,
        platform,
        buildOptions,
        buildCredentials,
      })),
    })

    if (builderResponse.ok) {
      const builderJob = await builderResponse.json() as BuilderJobResponse
      cloudlog({
        requestId: c.get('requestId'),
        message: 'Builder job created successfully',
        job_id: builderJob.jobId,
        upload_url: builderJob.uploadUrl,
      })
      return builderJob
    }

    const errorText = await builderResponse.text()
    const responseHeaders: Record<string, string> = {}
    builderResponse.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Builder API returned error',
      builder_url: builderUrl,
      status: builderResponse.status,
      status_text: builderResponse.statusText,
      error_body: errorText,
      response_headers: responseHeaders,
      org_id: orgId,
      app_id: appId,
      platform,
    })
    throwBuilderUnavailable('Build service unavailable (builder error)', {
      status: builderResponse.status,
      statusText: builderResponse.statusText,
    })
  }
  catch (error) {
    if (error && typeof error === 'object' && 'status' in error && (error as { status?: unknown }).status === 503) {
      throw error
    }
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Builder API fetch failed',
      builder_url: builderUrl,
      error: (error as Error)?.message,
      error_stack: (error as Error)?.stack,
      error_name: (error as Error)?.name,
      org_id: orgId,
      app_id: appId,
      platform,
    })
    throwBuilderUnavailable('Build service unavailable (builder call failed)', {}, error)
  }
}

function ensureBuilderUploadUrl(c: Context, builderUrl: string, builderApiKey: string, builderJob: BuilderJobResponse) {
  if (!builderJob.uploadUrl) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Builder did not return uploadUrl; rejecting request',
      builder_url: builderUrl,
      builder_api_key_present: !!builderApiKey,
    })
    throwBuilderUnavailable('Build service unavailable (upload URL missing)')
  }
}

function getBuildUploadUrl(c: Context, builderJob: BuilderJobResponse) {
  return `${getEnv(c, 'PUBLIC_URL') || 'https://api.capgo.app'}/build/upload/${builderJob.jobId}`
}

async function persistBuildRequest(c: Context, input: {
  app_id: string
  org_id: string
  requested_by: string
  platform: 'ios' | 'android'
  build_mode: 'release' | 'debug'
  build_config: Record<string, any>
  builder_job_id: string
  upload_session_key: string
  upload_path: string
  upload_url: string
  upload_expires_at: Date
}) {
  const {
    app_id,
    org_id,
    requested_by,
    platform,
    build_mode,
    build_config,
    builder_job_id,
    upload_session_key,
    upload_path,
    upload_url,
    upload_expires_at,
  } = input

  const supabaseAdminClient = supabaseAdmin(c)
  const { data: buildRequestRow, error: insertError } = await supabaseAdminClient
    .from('build_requests')
    .insert({
      app_id,
      owner_org: org_id,
      requested_by,
      platform,
      build_mode,
      build_config,
      status: 'pending',
      builder_job_id,
      upload_session_key,
      upload_path,
      upload_url,
      upload_expires_at: upload_expires_at.toISOString(),
    })
    .select('*')
    .single()

  if (insertError || !buildRequestRow) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to persist build request', error: insertError })
    throw simpleError('internal_error', 'Unable to persist build request')
  }

  return buildRequestRow
}

async function recordBuildRequestedTelemetry(c: Context, input: {
  app_id: string
  org_id: string
  platform: 'ios' | 'android'
  build_mode: 'release' | 'debug'
  user_id: string
}) {
  // Telemetry MUST NOT break the build request. sendEventToTracking swallows
  // per-provider errors internally, but defend against an unexpected throw at
  // the orchestration layer (e.g. backgroundTask unavailable in tests).
  try {
    await sendEventToTracking(c, {
      event: 'Build Requested',
      channel: 'build-lifecycle',
      icon: '🛠️',
      notify: false,
      user_id: input.user_id,
      groups: { organization: input.org_id },
      tags: {
        app_id: input.app_id,
        org_id: input.org_id,
        platform: input.platform,
        build_mode: input.build_mode,
      },
    })
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Build Requested telemetry failed',
      error: serializeError(error),
    })
  }
}

export async function requestBuild(
  c: Context,
  body: RequestBuildBody,
  apikey: Database['public']['Tables']['apikeys']['Row'],
): Promise<Response> {
  const {
    app_id,
    platform,
    build_mode,
    build_config,
    build_options,
    build_credentials,
  } = validateBuildRequestBody(c, body, apikey.user_id)

  await ensureBuildPermission(c, app_id, apikey.user_id)

  // Use authenticated client for data queries - RLS will enforce access
  const supabase = supabaseApikey(c, apikey.key)
  const org_id = await getBuildOwnerOrg(c, supabase, app_id)
  await ensureBuildTimePlanAllowed(c, supabase, org_id, app_id)
  // Fail before creating a builder job / upload session when the org is already
  // at its plan concurrency. /build/start still enforces transactionally.
  await assertNativeBuildConcurrencyAvailable(c, {
    orgId: org_id,
    appId: app_id,
    userId: apikey.user_id,
  })

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Creating job in builder',
    org_id,
    app_id,
    platform,
  })

  // Create upload_path BEFORE calling builder so we can pass it
  const upload_session_key = crypto.randomUUID()
  const upload_path = `orgs/${org_id}/apps/${app_id}/native-builds/${upload_session_key}.zip`
  const { builderUrl, builderApiKey } = getBuilderConfig(c)
  const builderJob = await createBuilderJob(c, {
    builderUrl,
    builderApiKey,
    orgId: org_id,
    actorUserId: apikey.user_id,
    appId: app_id,
    platform,
    uploadPath: upload_path,
    buildOptions: build_options,
    buildCredentials: build_credentials,
  })

  ensureBuilderUploadUrl(c, builderUrl, builderApiKey, builderJob)

  const upload_expires_at = new Date(Date.now() + 60 * 60 * 1000)
  const upload_url = getBuildUploadUrl(c, builderJob)
  cloudlog({
    requestId: c.get('requestId'),
    message: 'Using Capgo TUS proxy URL for builder',
    proxy_url: upload_url,
    builder_url: builderJob.uploadUrl,
  })

  const buildRequestRow = await persistBuildRequest(c, {
    app_id,
    org_id,
    requested_by: apikey.user_id,
    platform,
    build_mode,
    build_config,
    builder_job_id: builderJob.jobId,
    upload_session_key,
    upload_path,
    upload_url,
    upload_expires_at,
  })

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Build job created',
    job_id: builderJob.jobId,
    org_id,
    app_id,
    platform,
  })

  await recordBuildRequestedTelemetry(c, {
    app_id,
    org_id,
    platform,
    build_mode,
    user_id: apikey.user_id,
  })

  return c.json({
    build_request_id: buildRequestRow.id,
    job_id: builderJob.jobId,
    upload_session_key,
    upload_path,
    upload_url, // Capgo proxy URL
    upload_expires_at: upload_expires_at.toISOString(),
    status: buildRequestRow.status,
  } satisfies RequestBuildResponse, 200)
}
