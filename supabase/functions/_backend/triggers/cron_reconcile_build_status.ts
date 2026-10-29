import type { Context } from 'hono'
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
import { getBuilderXcodeVersion } from '../utils/builder_machine.ts'
import { persistBuilderBuildOutcome } from '../utils/builder_onboarding_checklist.ts'
import { BRES, middlewareAPISecret } from '../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { queryJson } from '../utils/pg_rls.ts'
import { recordBuildTime } from '../utils/supabase.ts'
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

const MISSING_BUILDER_JOB_ERROR = 'Build job no longer exists in builder'

interface StaleBuild {
  id: string
  builder_job_id: string | null
  app_id: string
  owner_org: string
  requested_by: string
  platform: string
  build_mode: string
  status: string
  created_at: string
}

interface BuildRequestPatch {
  status: string
  last_error: string | null
  runner_wait_seconds?: number | null
  started_at?: string
  completed_at?: string
  xcode_version?: string
  updated_at: string
}

// CAS update: only advances the row when its status is still `previousStatus`.
// Undefined optional fields keep the current column value, like an omitted PATCH key.
async function updateBuildRequestIfStatus(pg: Awaited<ReturnType<typeof getPgClient>>, id: string, previousStatus: string, patch: BuildRequestPatch) {
  const hasRunnerWait = 'runner_wait_seconds' in patch
  const result = await pg.query(
    `UPDATE public.build_requests SET
      status = $3,
      last_error = $4,
      runner_wait_seconds = CASE WHEN $5::boolean THEN $6::bigint ELSE runner_wait_seconds END,
      started_at = COALESCE($7::timestamptz, started_at),
      completed_at = COALESCE($8::timestamptz, completed_at),
      xcode_version = COALESCE($9::text, xcode_version),
      updated_at = $10::timestamptz
    WHERE id = $1 AND status = $2
    RETURNING id`,
    [
      id,
      previousStatus,
      patch.status,
      patch.last_error,
      hasRunnerWait,
      patch.runner_wait_seconds ?? null,
      patch.started_at ?? null,
      patch.completed_at ?? null,
      patch.xcode_version ?? null,
      patch.updated_at,
    ],
  )
  return result.rows as { id: string }[]
}

function isMissingBuilderJob(status: number, body: string): boolean {
  return (status === 404 || status === 500) && /job not found/i.test(body)
}

export const app = new Hono<MiddlewareKeyVariables>()

async function cancelTimedOutBuilderJob(builderUrl: string, builderApiKey: string, jobId: string): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)
  try {
    return await fetch(`${builderUrl}/jobs/${jobId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': builderApiKey },
      // The builder logs why the build stopped instead of "cancelled by user".
      body: JSON.stringify({ reason: 'timeout' }),
      signal: controller.signal,
    })
  }
  finally {
    clearTimeout(timeoutId)
  }
}

app.post('/', middlewareAPISecret, async (c) => {
  const builderUrl = getEnv(c, 'BUILDER_URL')
  const builderApiKey = getEnv(c, 'BUILDER_API_KEY')

  if (!builderUrl || !builderApiKey) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Missing BUILDER_URL or BUILDER_API_KEY env var, skipping reconciliation' })
    return c.json(BRES)
  }

  const pg = await getPgClient(c)
  try {
    return await reconcileBuilds(c, pg, builderUrl, builderApiKey)
  }
  finally {
    closeClient(c, pg)
  }
})

async function reconcileBuilds(c: Context<MiddlewareKeyVariables>, pg: Awaited<ReturnType<typeof getPgClient>>, builderUrl: string, builderApiKey: string) {
  const startTime = Date.now()
  let reconciled = 0
  let timedOut = 0
  let orphaned = 0
  let missing = 0
  let errors = 0

  let staleBuilds: StaleBuild[]
  try {
    staleBuilds = await queryJson<StaleBuild>(
      pg,
      `SELECT id, builder_job_id, app_id, owner_org, requested_by, platform, build_mode, status, created_at
      FROM public.build_requests
      WHERE status <> ALL($1::varchar[])
        AND updated_at < $2::timestamptz
      ORDER BY updated_at ASC
      LIMIT $3`,
      [[...TERMINAL_BUILD_STATUSES], new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000).toISOString(), BATCH_LIMIT],
    )
  }
  catch (queryError) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to query stale build_requests', error: queryError instanceof Error ? queryError.message : String(queryError) })
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
      const updatedRows = await updateBuildRequestIfStatus(pg, build.id, build.status, {
        status: BUILD_TIMEOUT_STATUS,
        last_error: 'Build request was never submitted to builder',
        updated_at: new Date().toISOString(),
      })
      if (!updatedRows.length)
        return false
      if (build.platform === 'ios' || build.platform === 'android')
        await persistBuilderBuildOutcome(c, { appId: build.app_id, platform: build.platform, status: BUILD_TIMEOUT_STATUS })
      return true
    }),
  )

  for (let i = 0; i < orphanResults.length; i++) {
    const result = orphanResults[i]
    if (result.status === 'fulfilled') {
      if (result.value)
        orphaned++
    }
    else {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to mark orphan build as failed', buildId: orphanBuilds[i].id, error: result.reason })
      errors++
    }
  }

  const appTimeouts = new Map<string, { timeoutSeconds: number, timeoutUpdatedAt: string }>()
  if (builderBuilds.length > 0) {
    const appIds = [...new Set(builderBuilds.map(build => build.app_id))]
    let appTimeoutRows: { app_id: string, build_timeout_seconds: number, build_timeout_updated_at: string }[]
    try {
      appTimeoutRows = await queryJson<{ app_id: string, build_timeout_seconds: number, build_timeout_updated_at: string }>(
        pg,
        'SELECT app_id, build_timeout_seconds, build_timeout_updated_at FROM public.apps WHERE app_id = ANY($1::varchar[])',
        [appIds],
      )
    }
    catch (appTimeoutError) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to query app build timeouts', error: appTimeoutError instanceof Error ? appTimeoutError.message : String(appTimeoutError) })
      return c.json(BRES)
    }

    for (const app of appTimeoutRows) {
      appTimeouts.set(app.app_id, {
        timeoutSeconds: app.build_timeout_seconds,
        timeoutUpdatedAt: app.build_timeout_updated_at,
      })
    }
  }

  // Builder answers 500 "job not found" once a job is purged from its
  // database. Such a build can never be reconciled, so settle it as failed
  // instead of retrying it on every cron run forever.
  async function markMissingBuilderJobFailed(build: typeof builderBuilds[number]) {
    const updatedRows = await updateBuildRequestIfStatus(pg, build.id, build.status, {
      status: BUILD_TIMEOUT_STATUS,
      last_error: MISSING_BUILDER_JOB_ERROR,
      updated_at: new Date().toISOString(),
    })
    if (!updatedRows.length)
      return
    missing++
    if (build.platform === 'ios' || build.platform === 'android')
      await persistBuilderBuildOutcome(c, { appId: build.app_id, platform: build.platform, status: BUILD_TIMEOUT_STATUS })
  }

  const builderResults = await Promise.allSettled(
    builderBuilds.map(async (build) => {
      const response = await fetch(`${builderUrl}/jobs/${build.builder_job_id}`, {
        method: 'GET',
        headers: { 'x-api-key': builderApiKey },
      })

      if (!response.ok) {
        // Always drain the body: unread responses pin one of the few concurrent
        // connection slots and Workers cancels them as a stalled deadlock.
        const errorText = await response.text().catch(() => '')
        if (isMissingBuilderJob(response.status, errorText) && new Date(build.created_at).getTime() < orphanCutoff)
          return await markMissingBuilderJobFailed(build)
        throw new Error(`Builder status fetch failed: ${response.status} ${errorText.slice(0, 200)}`.trim())
      }

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
            await cancelResponse.body?.cancel()
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

      // Optimistic concurrency-control (CAS) guard: `WHERE status = previousStatus`
      // ensures only one writer wins when the cron races with a CLI/dashboard
      // poller on the same row. `RETURNING id` lets us detect whether this
      // writer actually advanced the row; if `updatedRows` is empty, another
      // writer already moved the status and has emitted the transition — skip
      // emission here. The cron's per-build loop is inside Promise.allSettled,
      // so a lost race must NOT throw: we just skip the event and continue.
      const updatedRows = await updateBuildRequestIfStatus(pg, build.id, previousStatus, {
        status: effectiveStatus,
        last_error: effectiveError,
        runner_wait_seconds: runnerWaitSeconds,
        started_at: isoFromBuilderTimestamp(builderJob.job.started_at) ?? undefined,
        completed_at: isoFromBuilderTimestamp(effectiveCompletedAt) ?? undefined,
        xcode_version: getBuilderXcodeVersion(builderJob.machine) ?? undefined,
        updated_at: new Date().toISOString(),
      })

      const transitionApplied = updatedRows.length > 0

      if (transitionApplied && (build.platform === 'ios' || build.platform === 'android'))
        await persistBuilderBuildOutcome(c, { appId: build.app_id, platform: build.platform, status: effectiveStatus })

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
          jobId: build.builder_job_id!,
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
    missing,
    errors,
  })

  return c.json(BRES)
}
