import type { AndroidOnboardingErrorCategory, AndroidOnboardingStep } from './android/types.js'
import type { OnboardingErrorCategory, OnboardingStep, Platform } from './types.js'
import { sendEvent } from '../../utils.js'
import { getActiveCliReplaySessionId } from '../../init/replay.js'
import { mapAndroidOnboardingError, mapIosOnboardingError } from './error-categories.js'

function addReplaySessionTag(tags: Record<string, string>, replaySessionId?: string) {
  const sessionId = replaySessionId || getActiveCliReplaySessionId()
  if (sessionId)
    tags.$session_id = sessionId
}

export interface TrackBuilderOnboardingStepInput {
  apikey: string
  appId: string
  orgId: string
  /** Correlation id tying every event from one onboarding run together. */
  journeyId: string
  platform: Platform
  step: OnboardingStep | AndroidOnboardingStep
  durationMs?: number
  /** Step whose elapsed time is represented by durationMs. */
  durationStep?: OnboardingStep | AndroidOnboardingStep
  /** Raw caught error — mapped via the platform's category mapper. Use this OR errorCategory, not both. */
  error?: unknown
  /** Pre-computed category. Takes precedence over `error` if both are present. */
  errorCategory?: OnboardingErrorCategory | AndroidOnboardingErrorCategory
  replaySessionId?: string
}

export type BuilderOnboardingAction
  // Shared (both platforms): which branch the user picked on the resume-prompt
  // fork — `continue` resumes saved progress, `restart` wipes it. Carries a
  // `choice` tag with that value.
  = | 'resume_prompt_decision'
    | 'android_sa_method_selected'
    | 'android_sa_validation_recovery_selected'
    | 'android_sa_validation_result'

export interface TrackBuilderOnboardingActionInput {
  apikey: string
  appId: string
  orgId: string
  /** Correlation id tying every event from one onboarding run together. */
  journeyId: string
  platform: Platform
  step: OnboardingStep | AndroidOnboardingStep
  action: BuilderOnboardingAction
  tags?: Record<string, boolean | number | string>
  replaySessionId?: string
}

export async function trackBuilderOnboardingStep(input: TrackBuilderOnboardingStepInput): Promise<void> {
  const tags: Record<string, string> = {
    journey_id: input.journeyId,
    step: input.step,
    platform: input.platform,
    app_id: input.appId,
  }

  if (typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)) {
    tags.duration_ms = String(Math.round(input.durationMs))
    if (input.durationStep)
      tags.duration_step = input.durationStep
  }

  if (input.errorCategory !== undefined) {
    tags.error_category = input.errorCategory
  }
  else if (input.error !== undefined) {
    tags.error_category = input.platform === 'ios'
      ? mapIosOnboardingError(input.error)
      : mapAndroidOnboardingError(input.error)
  }

  addReplaySessionTag(tags, input.replaySessionId)

  try {
    await sendEvent(input.apikey, {
      event: 'Builder Onboarding Step',
      channel: 'builder-onboarding',
      org_id: input.orgId,
      tracking_version: 2,
      tags,
    })
  }
  catch {
    // Telemetry must never break the wizard. sendEvent already swallows
    // fetch failures internally; this catch covers anything else.
  }
}

export async function trackBuilderOnboardingAction(input: TrackBuilderOnboardingActionInput): Promise<void> {
  const tags: Record<string, string> = {}

  for (const [key, value] of Object.entries(input.tags ?? {}))
    tags[key] = String(value)

  tags.journey_id = input.journeyId
  tags.step = input.step
  tags.platform = input.platform
  tags.app_id = input.appId
  tags.action = input.action
  addReplaySessionTag(tags, input.replaySessionId)

  try {
    await sendEvent(input.apikey, {
      event: 'Builder Onboarding Action',
      channel: 'builder-onboarding',
      org_id: input.orgId,
      tracking_version: 2,
      tags,
    })
  }
  catch {
    // Telemetry must never break the wizard.
  }
}

export interface TrackBuilderOnboardingCancelledInput {
  apikey: string
  appId: string
  /** May be undefined when the owner org couldn't be resolved post-exit. */
  orgId?: string
  /** Correlation id tying every event from one onboarding run together. */
  journeyId: string
  /**
   * The platform being onboarded, or undefined when the user quit BEFORE
   * choosing one (e.g. on the platform picker). The undefined case is itself a
   * useful signal — it isolates "left at the very first screen" drop-off.
   */
  platform?: Platform
  /** The step the user was on when they quit, when known. */
  lastStep?: string
  /** Total wall-clock duration of the journey, from launch to quit. */
  durationMs?: number
  /**
   * Abort signal used to time-box the post-quit flush so a stalled network
   * can't keep the CLI alive after the user has already exited the wizard.
   */
  signal?: AbortSignal
  replaySessionId?: string
}

/**
 * Emits the terminal "Builder Onboarding Quit" event when a journey ends
 * without reaching build-complete (user cancel, Ctrl+C, missing platform, or a
 * fatal error that exits). Fired ONCE from command.ts after the wizard tears
 * down — never mid-flow — so each journey has at most one quit marker. Unlike
 * the per-step events this carries no org-scoped requirement: it sends with
 * whatever org id could be resolved (possibly none) rather than dropping the
 * event, because a quit is exactly when we most want the funnel exit recorded.
 */
export async function trackBuilderOnboardingCancelled(input: TrackBuilderOnboardingCancelledInput): Promise<void> {
  const tags: Record<string, string> = {
    journey_id: input.journeyId,
    app_id: input.appId,
  }

  if (input.platform)
    tags.platform = input.platform
  if (input.lastStep)
    tags.last_step = input.lastStep
  if (typeof input.durationMs === 'number' && Number.isFinite(input.durationMs))
    tags.duration_ms = String(Math.round(input.durationMs))
  addReplaySessionTag(tags, input.replaySessionId)

  try {
    await sendEvent(input.apikey, {
      event: 'Builder Onboarding Quit',
      channel: 'builder-onboarding',
      org_id: input.orgId,
      tracking_version: 2,
      tags,
    }, undefined, input.signal)
  }
  catch {
    // Telemetry must never break the exit path.
  }
}
