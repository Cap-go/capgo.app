import { pushEvent } from '~/services/posthog'

export const ONBOARDING_ANALYTICS_VERSION = 2

export type OnboardingAnalyticsFlow = 'pre_org' | 'existing_org'
export type OnboardingAnalyticsStep = 'intent' | 'details' | 'organization' | 'choice' | 'install' | 'setup'
export type OnboardingCopyEvent = 'onboarding_ai_instructions_copied' | 'onboarding_cli_command_copied'
export type OnboardingIntent = 'ota' | 'builder' | 'both' | 'exploring'
export type OnboardingDetailsEvent
  = | 'onboarding_app_id_entered'
    | 'onboarding_app_id_help_opened'
    | 'onboarding_app_icon_picked'
    | 'onboarding_app_icon_picker_closed_without_selection'
    | 'onboarding_app_icon_picker_open_failed'
    | 'onboarding_app_icon_picker_opened'
    | 'onboarding_app_icon_upload_failed'
    | 'onboarding_app_icon_uploaded'
    | 'onboarding_app_name_entered'
    | 'onboarding_store_import_failed'
    | 'onboarding_store_import_hidden'
    | 'onboarding_store_import_shown'
    | 'onboarding_store_import_submitted'
    | 'onboarding_store_import_succeeded'
    | 'onboarding_store_url_entered'

type AnalyticsPrimitive = string | number | boolean
type AnalyticsProperties = Record<string, AnalyticsPrimitive>
type CaptureEvent = (name: string, supaHost: string, properties?: AnalyticsProperties) => void

interface OnboardingResumeCandidate {
  lastRunId?: string
  onboardingAttemptId?: string
  savedStep: OnboardingAnalyticsStep
  steps: readonly OnboardingAnalyticsStep[]
}

interface CreateOnboardingTelemetryIdentityOptions {
  capture?: CaptureEvent
  flow: OnboardingAnalyticsFlow
  idFactory?: () => string
  supaHost: string
}

export interface OnboardingStepCompletionProperties {
  appId?: string
  intent?: OnboardingIntent
  nextStep?: OnboardingAnalyticsStep
  storeImportUsed?: boolean
}

export interface OnboardingDetailsEventProperties {
  field_length?: number
  icon_source?: 'file' | 'store'
}

export interface OnboardingCopyEventProperties {
  app_id?: string
  existing_app?: boolean
  intent?: OnboardingIntent
  org_id?: string
  setup_command: 'builder' | 'ota'
}

export type OnboardingDetailsField = 'app_id' | 'app_name' | 'store_url'

export function createOnboardingDetailsFieldDebouncer(
  emit: (name: OnboardingDetailsEvent, properties: OnboardingDetailsEventProperties) => void,
  delayMs = 1_000,
) {
  const timers = new Map<OnboardingDetailsField, ReturnType<typeof setTimeout>>()
  const pending = new Map<OnboardingDetailsField, { name: OnboardingDetailsEvent, properties: OnboardingDetailsEventProperties }>()

  function schedule(name: OnboardingDetailsEvent, field: OnboardingDetailsField, value: string) {
    const activeTimer = timers.get(field)
    if (activeTimer)
      clearTimeout(activeTimer)

    const normalizedValue = value.trim()
    if (!normalizedValue) {
      timers.delete(field)
      pending.delete(field)
      return
    }

    const event = { name, properties: { field_length: normalizedValue.length } }
    pending.set(field, event)
    timers.set(field, setTimeout(() => {
      emit(event.name, event.properties)
      timers.delete(field)
      pending.delete(field)
    }, delayMs))
  }

  function dispose() {
    for (const timer of timers.values())
      clearTimeout(timer)
    for (const event of pending.values())
      emit(event.name, event.properties)
    timers.clear()
    pending.clear()
  }

  return { dispose, schedule }
}

export function createOnboardingTelemetryIdentity(options: CreateOnboardingTelemetryIdentityOptions) {
  const capture = options.capture ?? pushEvent
  const idFactory = options.idFactory ?? (() => crypto.randomUUID())
  const initialAttemptId = idFactory()
  const onboardingRunId = `ir_${idFactory()}`
  let activeAttemptId = initialAttemptId
  let candidate: OnboardingResumeCandidate | undefined
  const recorded = { decision: false, dialog: false }

  function safelyCapture(name: string, properties: AnalyticsProperties) {
    try {
      capture(name, options.supaHost, properties)
    }
    catch {
      // Analytics must never interrupt onboarding.
    }
  }

  function resumeProperties(resumeCandidate: OnboardingResumeCandidate): AnalyticsProperties {
    return {
      flow: options.flow,
      onboarding_attempt_id: activeAttemptId,
      onboarding_run_id: onboardingRunId,
      onboarding_version: ONBOARDING_ANALYTICS_VERSION,
      ...(resumeCandidate.onboardingAttemptId ? { resume_onboarding_attempt_id: resumeCandidate.onboardingAttemptId } : {}),
      ...(resumeCandidate.lastRunId ? { resumed_from_run_id: resumeCandidate.lastRunId } : {}),
      saved_step: resumeCandidate.savedStep,
      step_index: resumeCandidate.steps.indexOf(resumeCandidate.savedStep),
      total_steps: resumeCandidate.steps.length,
    }
  }

  function recordResumeDialogViewed() {
    if (recorded.dialog || !candidate)
      return
    recorded.dialog = true
    safelyCapture('onboarding_resume_dialog_viewed', resumeProperties(candidate))
  }

  function recordDecision(name: string, continueSavedAttempt: boolean) {
    if (recorded.decision || !candidate)
      return
    recorded.decision = true
    const previousAttemptId = activeAttemptId
    if (continueSavedAttempt && candidate.onboardingAttemptId)
      activeAttemptId = candidate.onboardingAttemptId

    const properties = resumeProperties(candidate)
    if (activeAttemptId !== previousAttemptId)
      properties.initial_onboarding_attempt_id = initialAttemptId
    safelyCapture(name, properties)
  }

  return {
    get attemptId() { return activeAttemptId },
    get runId() { return onboardingRunId },
    getProgressMetadata: () => ({ onboardingAttemptId: activeAttemptId, lastRunId: onboardingRunId }),
    prepareResumeCandidate(next: OnboardingResumeCandidate) {
      candidate = next
    },
    recordResumeContinued: () => recordDecision('onboarding_resume_continued', true),
    recordResumeDialogViewed,
    recordResumeRestarted: () => recordDecision('onboarding_resume_restarted', false),
  }
}

interface CreateOnboardingProgressTrackerOptions {
  capture?: CaptureEvent
  flow: OnboardingAnalyticsFlow
  now?: () => number
  onboardingAttemptId: string
  onboardingRunId: string
  resumed: boolean
  steps: readonly OnboardingAnalyticsStep[]
  supaHost: string
}

export function createOnboardingProgressTracker(options: CreateOnboardingProgressTrackerOptions) {
  const capture = options.capture ?? pushEvent
  const now = options.now ?? Date.now
  let activeStep: OnboardingAnalyticsStep | null = null
  let activePreviousStep: OnboardingAnalyticsStep | null = null
  let activeStepViewedAt = 0
  let activeStepCompleted = false

  function sharedProperties(step: OnboardingAnalyticsStep): AnalyticsProperties | null {
    const stepIndex = options.steps.indexOf(step)
    if (stepIndex < 0)
      return null

    return {
      flow: options.flow,
      onboarding_attempt_id: options.onboardingAttemptId,
      onboarding_run_id: options.onboardingRunId,
      onboarding_version: ONBOARDING_ANALYTICS_VERSION,
      resumed: options.resumed,
      step,
      step_index: stepIndex,
      total_steps: options.steps.length,
    }
  }

  function safelyCapture(name: string, properties: AnalyticsProperties) {
    try {
      capture(name, options.supaHost, properties)
    }
    catch {
      // Analytics must never interrupt onboarding.
    }
  }

  function viewStep(step: OnboardingAnalyticsStep, previousStep?: OnboardingAnalyticsStep) {
    const properties = sharedProperties(step)
    if (!properties)
      return

    activeStep = step
    activePreviousStep = previousStep ?? null
    activeStepViewedAt = now()
    activeStepCompleted = false

    if (previousStep)
      properties.previous_step = previousStep

    safelyCapture('onboarding_step_viewed', properties)
  }

  function completeStep(step: OnboardingAnalyticsStep, completion: OnboardingStepCompletionProperties = {}) {
    if (activeStep !== step || activeStepCompleted)
      return

    const properties = sharedProperties(step)
    if (!properties)
      return

    activeStepCompleted = true
    properties.duration_ms = Math.max(0, Math.floor(now() - activeStepViewedAt))

    if (activePreviousStep)
      properties.previous_step = activePreviousStep
    if (completion.nextStep)
      properties.next_step = completion.nextStep
    if (completion.appId)
      properties.app_id = completion.appId
    if (completion.intent)
      properties.intent = completion.intent
    if (completion.storeImportUsed !== undefined)
      properties.store_import_used = completion.storeImportUsed

    safelyCapture('onboarding_step_completed', properties)
  }

  function trackDetailsEvent(name: OnboardingDetailsEvent, details: OnboardingDetailsEventProperties = {}) {
    const properties = sharedProperties('details')
    if (!properties)
      return

    safelyCapture(name, { ...properties, ...details })
  }

  function trackCopyEvent(name: OnboardingCopyEvent, details: OnboardingCopyEventProperties) {
    if (!activeStep)
      return null

    const properties = sharedProperties(activeStep)
    if (!properties)
      return null

    const eventProperties: AnalyticsProperties = {
      ...properties,
      setup_command: details.setup_command,
    }
    if (details.app_id)
      eventProperties.app_id = details.app_id
    if (details.existing_app !== undefined)
      eventProperties.existing_app = details.existing_app
    if (details.intent)
      eventProperties.intent = details.intent
    if (details.org_id)
      eventProperties.org_id = details.org_id

    safelyCapture(name, eventProperties)
    return eventProperties
  }

  function trackDashboardExplored(appId?: string) {
    if (!activeStep)
      return

    const properties = sharedProperties(activeStep)
    if (!properties)
      return
    if (appId)
      properties.app_id = appId

    safelyCapture('onboarding_dashboard_explored', properties)
  }

  return {
    completeStep,
    trackCopyEvent,
    trackDashboardExplored,
    trackDetailsEvent,
    viewStep,
  }
}
