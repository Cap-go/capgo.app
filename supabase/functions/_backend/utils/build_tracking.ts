import type { Context } from 'hono'
import { TERMINAL_BUILD_STATUSES } from './build_timeout.ts'
import { sendDiscordAlert } from './discord.ts'
import { cloudlogErr, serializeError } from './logging.ts'
import { supabaseAdmin } from './supabase.ts'
import { sendEventToTracking } from './tracking.ts'
import { backgroundTask } from './utils.ts'

export type BuildTransition = 'started' | 'succeeded' | 'failed' | 'timed_out'
export type BuildFailureCategory = 'timeout' | 'builder_error' | 'validation_error' | 'unknown'

// Substring hints — `'missing credential'` matches both singular and plural; `'validation'` is intentionally broad.
const VALIDATION_HINTS = ['invalid build_mode', 'missing credential', 'validation']

interface ClassifyInput {
  previous: string
  next: string
  timeoutApplied: boolean
}

export function classifyBuildTransition(input: ClassifyInput): BuildTransition | null {
  if (TERMINAL_BUILD_STATUSES.has(input.previous))
    return null

  // Timeout overrides the no-change check: a stale snapshot with the same
  // previous/next must still emit `timed_out` when the cron applied a timeout.
  if (input.timeoutApplied)
    return 'timed_out'

  if (input.previous === input.next)
    return null

  if (input.next === 'running')
    return 'started'

  if (input.next === 'succeeded')
    return 'succeeded'

  if (input.next === 'failed')
    return 'failed'

  return null
}

interface FailureInput {
  timeoutApplied: boolean
  errorMessage: string | null | undefined
}

export function mapBuildFailureCategory(input: FailureInput): BuildFailureCategory {
  if (input.timeoutApplied)
    return 'timeout'

  const message = (input.errorMessage ?? '').toLowerCase()
  if (!message)
    return 'unknown'

  for (const hint of VALIDATION_HINTS) {
    if (message.includes(hint))
      return 'validation_error'
  }

  return 'builder_error'
}

interface BuildRowForTracking {
  app_id: string
  platform: string
  build_mode: string
  owner_org: string
  requested_by: string
}

export interface EmitBuildTransitionInput {
  jobId?: string
  previousStatus: string
  effectiveStatus: string
  timeoutApplied: boolean
  effectiveError?: string | null
  effectiveBuildTimeSeconds?: number | null
  build: BuildRowForTracking
}

const EVENT_NAME_BY_TRANSITION: Record<BuildTransition, string> = {
  started: 'Build Started',
  succeeded: 'Build Succeeded',
  failed: 'Build Failed',
  timed_out: 'Build Timed Out',
}

async function sendFastBuildFailureAlert(c: Context, input: EmitBuildTransitionInput): Promise<void> {
  const duration = input.effectiveBuildTimeSeconds
  const jobId = input.jobId
  if (!jobId || duration === null || duration === undefined || duration >= 10)
    return

  try {
    const { data, error } = await supabaseAdmin(c)
      .from('users')
      .select('email')
      .eq('id', input.build.requested_by)
      .maybeSingle()

    if (error) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Fast build failure email lookup failed',
        job_id: jobId,
        error: error.message,
      })
    }

    await sendDiscordAlert(c, {
      content: '🚨 **Native build failed in under 10 seconds**',
      allowed_mentions: { parse: [] },
      embeds: [{
        title: 'Fast native build failure',
        color: 0xED4245,
        fields: [
          { name: 'Job ID', value: jobId },
          { name: 'Platform', value: input.build.platform, inline: true },
          { name: 'App ID', value: input.build.app_id, inline: true },
          { name: 'Email', value: data?.email?.trim() || 'unknown' },
          { name: 'Runtime', value: `${duration}s`, inline: true },
        ],
      }],
    })
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Fast build failure alert failed',
      job_id: jobId,
      error: serializeError(error),
    })
  }
}

/**
 * Emit the appropriate Build * lifecycle event for a status transition, or no-op when
 * `classifyBuildTransition` returns null (already-terminal previous status, or no change).
 *
 * Shared by:
 *   - the cron reconcile path (stale / abandoned builds), and
 *   - the public/build/start.ts + public/build/status.ts happy paths.
 *
 * The terminal-status idempotency guard in `classifyBuildTransition` means re-calls on
 * already-terminal rows are safe no-ops.
 */
export async function emitBuildTransitionEvent(c: Context, input: EmitBuildTransitionInput): Promise<void> {
  const transition = classifyBuildTransition({
    previous: input.previousStatus,
    next: input.effectiveStatus,
    timeoutApplied: input.timeoutApplied,
  })
  if (!transition)
    return

  const tags: Record<string, string> = {
    app_id: input.build.app_id,
    org_id: input.build.owner_org,
    platform: input.build.platform,
    build_mode: input.build.build_mode,
  }
  if (
    input.effectiveBuildTimeSeconds !== null
    && input.effectiveBuildTimeSeconds !== undefined
    && (transition === 'succeeded' || transition === 'failed' || transition === 'timed_out')
  ) {
    tags.duration_seconds = String(input.effectiveBuildTimeSeconds)
  }
  if (transition === 'failed' || transition === 'timed_out') {
    tags.failure_category = mapBuildFailureCategory({
      timeoutApplied: input.timeoutApplied,
      errorMessage: input.effectiveError ?? null,
    })
  }

  // Telemetry MUST NOT break the build flow. sendEventToTracking already swallows
  // each provider's failure individually, but defend against an unexpected throw
  // at the orchestration layer (e.g. backgroundTask unavailable in tests).
  try {
    await sendEventToTracking(c, {
      event: EVENT_NAME_BY_TRANSITION[transition],
      channel: 'build-lifecycle',
      user_id: input.build.requested_by,
      groups: { organization: input.build.owner_org },
      tags,
    })
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'emitBuildTransitionEvent failed',
      transition,
      error: serializeError(error),
    })
  }

  if (transition === 'failed')
    await backgroundTask(c, sendFastBuildFailureAlert(c, input))
}
