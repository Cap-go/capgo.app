import { pushEvent } from '~/services/posthog'

export const ONBOARDING_ANALYTICS_VERSION = 1

export type OnboardingAnalyticsFlow = 'pre_org' | 'existing_org'
export type OnboardingAnalyticsStep = 'intent' | 'details' | 'organization' | 'choice' | 'install' | 'setup'
export type OnboardingIntent = 'ota' | 'builder' | 'both' | 'exploring'

type AnalyticsPrimitive = string | number | boolean | null
type AnalyticsProperties = Record<string, AnalyticsPrimitive>
type CaptureEvent = (name: string, supaHost: string, properties?: AnalyticsProperties) => void

export interface OnboardingStepCompletionProperties {
  appId?: string
  intent?: OnboardingIntent
  nextStep?: OnboardingAnalyticsStep
  storeImportUsed?: boolean
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

  return {
    completeStep,
    viewStep,
  }
}
