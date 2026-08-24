import type { Context } from 'hono'
import { TERMINAL_BUILD_STATUSES } from './build_timeout.ts'
import { cloudlogErr, serializeError } from './logging.ts'
import { sendEventToTracking } from './tracking.ts'

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
}
