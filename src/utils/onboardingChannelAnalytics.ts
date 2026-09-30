export type OnboardingChannelStage
  = | 'channel-routing'
    | 'channel-self-assign'
    | 'channel-console-assign'
    | 'channel-create'

export type OnboardingChannelAnimationStage = Exclude<OnboardingChannelStage, 'channel-create'>

export type OnboardingChannelEvent
  = | 'onboarding_channel_animation_completed'
    | 'onboarding_channel_animation_interrupted'
    | 'onboarding_channel_animation_replayed'
    | 'onboarding_channel_animation_skipped'
    | 'onboarding_channel_animation_started'
    | 'onboarding_channel_animation_unavailable'
    | 'onboarding_channel_create_blocked'
    | 'onboarding_channel_create_continued'
    | 'onboarding_channel_create_existing_detected'
    | 'onboarding_channel_create_failed'
    | 'onboarding_channel_create_initialization_started'
    | 'onboarding_channel_create_loaded'
    | 'onboarding_channel_create_submitted'
    | 'onboarding_channel_create_succeeded'
    | 'onboarding_channel_flow_closed'
    | 'onboarding_channel_flow_opened'
    | 'onboarding_channel_name_entered'
    | 'onboarding_channel_name_suggestion_selected'
    | 'onboarding_channel_name_validation_failed'
    | 'onboarding_channel_reduced_motion_shown'
    | 'onboarding_channel_self_assign_toggled'
    | 'onboarding_channel_stage_backed'
    | 'onboarding_channel_stage_continued'
    | 'onboarding_channel_stage_viewed'

export interface OnboardingChannelEventProperties {
  allow_device_self_set?: boolean
  animation_duration_ms?: number
  animation_elapsed_ms?: number
  animation_progress_percent?: number
  animation_run_index?: number
  animation_trigger?: 'automatic' | 'replay'
  channel_name_length?: number
  channel_name_source?: 'manual' | 'suggestion'
  channel_flow_origin?: 'onboarding' | 'todo_list'
  channel_stage: OnboardingChannelStage
  created_in_onboarding?: boolean
  exit_action?: 'back' | 'continue' | 'unmounted'
  failure_phase?: 'channel_insert' | 'existing_channel_lookup' | 'initialization'
  failure_reason?: 'initializing' | 'insert_failed' | 'load_failed' | 'missing_identity' | 'name_invalid' | 'name_required' | 'name_taken' | 'permission_denied' | 'request_failed' | 'submitting' | 'timeline_unavailable'
  found_existing_channel?: boolean
  flow_exit_action?: 'closed' | 'completed'
  had_completed_animation?: boolean
  navigation_direction?: 'backward' | 'forward'
  next_channel_stage?: OnboardingChannelStage | 'setup' | 'install'
  permission_state?: 'denied' | 'granted' | 'not_checked'
  reduced_motion?: boolean
  replay_count?: number
  selected_suggestion?: 'beta' | 'development' | 'production'
  watch_duration_ms?: number
}

export function withOnboardingChannelOrigin(
  properties: OnboardingChannelEventProperties,
  origin = properties.channel_flow_origin ?? 'onboarding',
): OnboardingChannelEventProperties {
  return { ...properties, channel_flow_origin: origin }
}

interface AnimationProgressSource {
  durationMs: () => number
  progress: () => number
}

interface CreateOnboardingChannelAnimationTrackerOptions {
  emit: (event: OnboardingChannelEvent, properties: OnboardingChannelEventProperties) => void
  now?: () => number
  stage: OnboardingChannelAnimationStage
}

function finiteNonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

export function createOnboardingChannelAnimationTracker(options: CreateOnboardingChannelAnimationTrackerOptions) {
  const now = options.now ?? Date.now
  let active = false
  let completed = false
  let completedWatchDurationMs: number | null = null
  let disposed = false
  let exitRecorded = false
  let reducedMotion = false
  let replayCount = 0
  let reducedMotionShown = false
  let runIndex = 0
  let startedAt = 0
  let stageViewed = false
  let progressSource: AnimationProgressSource | null = null

  function emit(event: OnboardingChannelEvent, properties: Omit<OnboardingChannelEventProperties, 'channel_stage'> = {}) {
    options.emit(event, {
      channel_stage: options.stage,
      ...properties,
    })
  }

  function viewStage() {
    if (stageViewed)
      return
    stageViewed = true
    emit('onboarding_channel_stage_viewed', { reduced_motion: reducedMotion })
  }

  function progressProperties(): OnboardingChannelEventProperties {
    const durationMs = Math.round(finiteNonNegative(progressSource?.durationMs() ?? 0))
    const progress = Math.min(1, finiteNonNegative(progressSource?.progress() ?? (completed ? 1 : 0)))
    return {
      animation_duration_ms: durationMs,
      animation_elapsed_ms: Math.round(durationMs * progress),
      animation_progress_percent: Math.round(progress * 100),
      animation_run_index: runIndex,
      channel_stage: options.stage,
      had_completed_animation: completed,
      reduced_motion: reducedMotion,
      replay_count: replayCount,
      watch_duration_ms: active
        ? Math.round(finiteNonNegative(now() - startedAt))
        : completedWatchDurationMs ?? 0,
    }
  }

  function start(trigger: 'automatic' | 'replay', source: AnimationProgressSource) {
    if (disposed)
      return
    reducedMotion = false
    active = true
    completed = false
    completedWatchDurationMs = null
    exitRecorded = false
    progressSource = source
    runIndex += 1
    startedAt = now()
    viewStage()
    emit('onboarding_channel_animation_started', {
      ...progressProperties(),
      animation_trigger: trigger,
    })
  }

  function replaceProgressSource(source: AnimationProgressSource) {
    if (disposed || reducedMotion || runIndex === 0)
      return false
    progressSource = source
    return true
  }

  function complete() {
    if (!active || completed || disposed)
      return
    completedWatchDurationMs = Math.round(finiteNonNegative(now() - startedAt))
    completed = true
    active = false
    emit('onboarding_channel_animation_completed', progressProperties())
  }

  function replayRequested() {
    if (disposed)
      return
    viewStage()
    replayCount += 1
    emit('onboarding_channel_animation_replayed', progressProperties())
    active = false
    completed = false
    completedWatchDurationMs = null
    exitRecorded = false
  }

  function showReducedMotion() {
    if (disposed)
      return
    reducedMotion = true
    active = false
    completed = true
    completedWatchDurationMs = 0
    exitRecorded = false
    progressSource = null
    startedAt = now()
    viewStage()
    if (reducedMotionShown)
      return
    reducedMotionShown = true
    emit('onboarding_channel_reduced_motion_shown', progressProperties())
  }

  function unavailable() {
    if (disposed)
      return
    active = false
    completed = false
    completedWatchDurationMs = null
    progressSource = null
    viewStage()
    emit('onboarding_channel_animation_unavailable', {
      failure_reason: 'timeline_unavailable',
      reduced_motion: reducedMotion,
    })
  }

  function leave(exitAction: 'back' | 'continue') {
    if (disposed || exitRecorded)
      return
    exitRecorded = true
    if (!active || completed)
      return
    const event = exitAction === 'continue'
      ? 'onboarding_channel_animation_skipped'
      : 'onboarding_channel_animation_interrupted'
    emit(event, {
      ...progressProperties(),
      exit_action: exitAction,
    })
    active = false
  }

  function dispose() {
    if (disposed)
      return
    if (active && !completed && !exitRecorded) {
      emit('onboarding_channel_animation_interrupted', {
        ...progressProperties(),
        exit_action: 'unmounted',
      })
    }
    disposed = true
    active = false
    completedWatchDurationMs = null
  }

  return {
    complete,
    dispose,
    leave,
    replayRequested,
    replaceProgressSource,
    showReducedMotion,
    start,
    unavailable,
  }
}
