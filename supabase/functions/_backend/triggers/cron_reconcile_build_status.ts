import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import {
  BUILD_TIMEOUT_STATUS,
  calculateBuildRuntimeSeconds,
  calculateRunnerWaitSeconds,
  calculateTimeoutCompletedAt,
  capBuildRuntimeSeconds,
  formatBuildTimeoutError,
  isTerminalBuildStatus,
  normalizeBuildTimeoutSeconds,
  shouldApplyBuildTimeout,
  TERMINAL_BUILD_STATUSES,
} from '../utils/build_timeout.ts'
import { emitBuildTransitionEvent } from '../utils/build_tracking.ts'
import { isoFromBuilderTimestamp } from '../utils/builder_capacity.ts'
import { BRES, middlewareAPISecret } from '../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { recordBuildTime, supabaseAdmin } from '../utils/supabase.ts'
import { getEnv } from '../utils/utils.ts'

interface BuilderStatusResponse {
  job: {
    status: string
    started_at: number | null
    completed_at: number | null
    runner_wait_ms?: number | null
    error: string | null
  }
  machine: Record<string, unknown> | null
  uploadUrl?: string
}

const STALE_THRESHOLD_MINUTES = 5
const ORPHAN_THRESHOLD_HOURS = 1
const BATCH_LIMIT = 500

export const app = new Hono<MiddlewareKeyVariables>()

async function cancelTimedOutBuilderJob(builderUrl: string, builderApiKey: string, jobId: string): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)
  try {
    return await fetch(`${builderUrl}/jobs/${jobId}/cancel`, {
      method: 'POST',
      headers: { 'x-api-key': builderApiKey },
      signal: controller.signal,
    })
  }
  finally {
    clearTimeout(timeoutId)
  }
}

app.post('/', middlewareAPISecret, async (c) => {
  const startTime = Date.now()
  let reconciled = 0
  let timedOut = 0
  let orphaned = 0
  let errors = 0

  const supabase = supabaseAdmin(c)
  const builderUrl = getEnv(c, 'BUILDER_URL')
  const builderApiKey = getEnv(c, 'BUILDER_API_KEY')

  if (!builderUrl || !builderApiKey) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Missing BUILDER_URL or BUILDER_API_KEY env var, skipping reconciliation' })
    return c.json(BRES)
  }

  const { data: staleBuilds, error: queryError } = await supabase
    .from('build_requests')
    .select('id, builder_job_id, app_id, owner_org, requested_by, platform, build_mode, status, created_at')
    .not('status', 'in', `(${[...TERMINAL_BUILD_STATUSES].join(',')})`)
    .lt('updated_at', new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000).toISOString())
    .order('updated_at', { ascending: true })
    .limit(BATCH_LIMIT)

  if (queryError) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to query stale build_requests', error: queryError.message })
    return c.json(BRES)
  }

  if (!staleBuilds || staleBuilds.length === 0) {
    cloudlog({ requestId: c.get('requestId'), message: 'No stale builds to reconcile' })
    return c.json(BRES)
  }

  cloudlog({ requestId: c.get('requestId'), message: `Found ${staleBuilds.length} stale builds to reconcile` })

  const orphanCutoff = Date.now() - ORPHAN_THRESHOLD_HOURS * 60 * 60 * 1000
  const orphanBuilds = staleBuilds.filter(b => !b.builder_job_id && new Date(b.created_at).getTime() < orphanCutoff)
  const builderBuilds = staleBuilds.filter(b => !!b.builder_job_id)

  const orphanResults = await Promise.allSettled(
    orphanBuilds.map(async (build) => {
      const { error: updateError } = await supabase
        .from('build_requests')
        .update({
          status: BUILD_TIMEOUT_STATUS,
          last_error: 'Build request was never submitted to builder',
          updated_at: new Date().toISOString(),
        })
        .eq('id', build.id)

      if (updateError)
        throw new Error(updateError.message)
    }),
  )

  for (let i = 0; i < orphanResults.length; i++) {
    if (orphanResults[i].status === 'fulfilled') {
      orphaned++
    }
    else {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to mark orphan build as failed', buildId: orphanBuilds[i].id, error: (orphanResults[i] as PromiseRejectedResult).reason })
      errors++
    }
  }

  const appTimeouts = new Map<string, { timeoutSeconds: number, timeoutUpdatedAt: string }>()
  if (builderBuilds.length > 0) {
    const appIds = [...new Set(builderBuilds.map(build => build.app_id))]
    const { data: appTimeoutRows, error: appTimeoutError } = await supabase
      .from('apps')
      .select('app_id, build_timeout_seconds, build_timeout_updated_at')
      .in('app_id', appIds)

    if (appTimeoutError) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to query app build timeouts', error: appTimeoutError.message })
      return c.json(BRES)
    }

    for (const app of appTimeoutRows ?? []) {
      appTimeouts.set(app.app_id, {
        timeoutSeconds: app.build_timeout_seconds,
        timeoutUpdatedAt: app.build_timeout_updated_at,
      })
    }
  }

  const builderResults = await Promise.allSettled(
    builderBuilds.map(async (build) => {
      const response = await fetch(`${builderUrl}/jobs/${build.builder_job_id}`, {
        method: 'GET',
        headers: { 'x-api-key': builderApiKey },
      })

      if (!response.ok)
        throw new Error(`Builder status fetch failed: ${response.status}`)

      const builderJob = await response.json() as BuilderStatusResponse
      const jobStatus = builderJob.job.status
      const appTimeout = appTimeouts.get(build.app_id)
      const timeoutSeconds = normalizeBuildTimeoutSeconds(appTimeout?.timeoutSeconds)
      const runtimeSeconds = calculateBuildRuntimeSeconds(builderJob.job.started_at, builderJob.job.completed_at)
      const runnerWaitSeconds = calculateRunnerWaitSeconds(builderJob.job.runner_wait_ms)
      const buildTimedOut = shouldApplyBuildTimeout(
        builderJob.job.started_at,
        builderJob.job.completed_at,
        jobStatus,
        timeoutSeconds,
        appTimeout?.timeoutUpdatedAt,
      )
      const timeoutCompletedAt = buildTimedOut && typeof builderJob.job.started_at === 'number'
        ? calculateTimeoutCompletedAt(builderJob.job.started_at, timeoutSeconds)
        : null
      let timeoutApplied = false

      if (buildTimedOut && builderJob.job.completed_at) {
        timeoutApplied = true
      }
      else if (buildTimedOut) {
        try {
          const cancelResponse = await cancelTimedOutBuilderJob(builderUrl, builderApiKey, build.builder_job_id!)
          if (cancelResponse.ok) {
            timeoutApplied = true
          }
          else {
            const errorText = await cancelResponse.text()
            cloudlogErr({
              requestId: c.get('requestId'),
              message: 'Failed to cancel timed out build in builder',
              buildId: build.id,
              jobId: build.builder_job_id,
              status: cancelResponse.status,
              error: errorText,
            })
          }
        }
        catch (error) {
          cloudlogErr({
            requestId: c.get('requestId'),
            message: 'Failed to cancel timed out build in builder',
            buildId: build.id,
            jobId: build.builder_job_id,
            error: String(error),
          })
        }
      }

      const effectiveStatus = timeoutApplied ? BUILD_TIMEOUT_STATUS : jobStatus
      const effectiveError = timeoutApplied ? formatBuildTimeoutError(timeoutSeconds) : builderJob.job.error || null
      const effectiveCompletedAt = timeoutApplied ? timeoutCompletedAt : builderJob.job.completed_at
      const effectiveBuildTimeSeconds = runtimeSeconds === null
        ? null
        : timeoutApplied
          ? capBuildRuntimeSeconds(runtimeSeconds, timeoutSeconds)
          : runtimeSeconds

      if (timeoutApplied)
        timedOut++

      const previousStatus = build.status

      // Optimistic concurrency-control (CAS) guard: `.eq('status', previousStatus)`
      // ensures only one writer wins when the cron races with a CLI/dashboard
      // poller on the same row. The `.select('id')` lets us detect whether this
      // writer actually advanced the row; if `updatedRows` is empty, another
      // writer already moved the status and has emitted the transition — skip
      // emission here. The cron's per-build loop is inside Promise.allSettled,
      // so a lost race must NOT throw: we just skip the event and continue.
      const { data: updatedRows, error: updateError } = await supabase
        .from('build_requests')
        .update({
          status: effectiveStatus,
          last_error: effectiveError,
          runner_wait_seconds: runnerWaitSeconds,
          started_at: isoFromBuilderTimestamp(builderJob.job.started_at) ?? undefined,
          completed_at: isoFromBuilderTimestamp(effectiveCompletedAt) ?? undefined,
          updated_at: new Date().toISOString(),
        })
        .eq('id', build.id)
        .eq('status', previousStatus)
        .select('id')

      if (updateError)
        throw new Error(updateError.message)

      const transitionApplied = !!updatedRows && updatedRows.length > 0

      // recordBuildTime stays unconditional on terminal status: it's idempotent
      // at the DB layer, and skipping it on the CAS-lost branch would let
      // billing miss a build (worse than the rare duplicate).
      if (
        (isTerminalBuildStatus(effectiveStatus) || timeoutApplied)
        && builderJob.job.started_at
        && effectiveCompletedAt
        && effectiveBuildTimeSeconds !== null
      ) {
        if (build.platform !== 'ios' && build.platform !== 'android') {
          cloudlogErr({ requestId: c.get('requestId'), message: 'Unexpected platform, skipping recordBuildTime', buildId: build.id, platform: build.platform })
        }
        else {
          await recordBuildTime(
            c,
            build.owner_org,
            build.requested_by,
            build.builder_job_id!,
            build.platform,
            effectiveBuildTimeSeconds,
            effectiveCompletedAt,
            build.app_id,
          )
        }
      }

      if (transitionApplied) {
        await emitBuildTransitionEvent(c, {
          previousStatus,
          effectiveStatus,
          timeoutApplied,
          effectiveError,
          effectiveBuildTimeSeconds,
          build: {
            app_id: build.app_id,
            platform: build.platform,
            build_mode: build.build_mode,
            owner_org: build.owner_org,
            requested_by: build.requested_by,
          },
        })
      }
      // else: another writer (start.ts/status.ts, or another cron tick) already
      // advanced this row and emitted — skip to avoid double-firing.
    }),
  )

  for (let i = 0; i < builderResults.length; i++) {
    if (builderResults[i].status === 'fulfilled') {
      reconciled++
    }
    else {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Error reconciling build', buildId: builderBuilds[i].id, jobId: builderBuilds[i].builder_job_id, error: String((builderResults[i] as PromiseRejectedResult).reason) })
      errors++
    }
  }

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Build status reconciliation completed',
    duration_ms: Date.now() - startTime,
    total: staleBuilds.length,
    reconciled,
    timed_out: timedOut,
    orphaned,
    errors,
  })

  return c.json(BRES)
})
