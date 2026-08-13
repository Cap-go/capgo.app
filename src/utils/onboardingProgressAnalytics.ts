import { pushEvent } from '~/services/posthog'

export const ONBOARDING_ANALYTICS_VERSION = 2

export type OnboardingAnalyticsFlow = 'pre_org' | 'existing_org'
export type OnboardingAnalyticsStep = 'intent' | 'details' | 'organization' | 'choice' | 'install' | 'setup'
export type OnboardingIntent = 'ota' | 'builder' | 'both' | 'exploring'
export type OnboardingActionEvent
  = | 'onboarding_ai_instructions_copy_clicked'
    | 'onboarding_ai_instructions_copied_with_api_key'
    | 'onboarding_ai_instructions_copied_without_api_key'
    | 'onboarding_cli_init_command_copied'
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

type AnalyticsPrimitive = string | number | boolean | null
type AnalyticsProperties = Record<string, AnalyticsPrimitive>
type CaptureEvent = (name: string, supaHost: string, properties?: AnalyticsProperties) => void

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

interface CreateOnboardingProgressTrackerOptions {
  capture?: CaptureEvent
  flow: OnboardingAnalyticsFlow
  now?: () => number
  resumed: boolean
  steps: readonly OnboardingAnalyticsStep[]
  supaHost: string
}

export function createOnboardingProgressTracker(options: CreateOnboardingProgressTrackerOptions) {
  const capture = options.capture ?? pushEvent
  const now = options.now ?? Date.now
  const onboardingAttemptId = crypto.randomUUID()
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
      onboarding_attempt_id: onboardingAttemptId,
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

  function trackActionEvent(name: OnboardingActionEvent) {
    if (!activeStep)
      return

    const properties = sharedProperties(activeStep)
    if (properties)
      safelyCapture(name, properties)
  }

  return {
    completeStep,
    trackActionEvent,
    trackDetailsEvent,
    viewStep,
  }
}
