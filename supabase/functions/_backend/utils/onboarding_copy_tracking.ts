import type { BentoTrackingPayload } from './tracking.ts'

export const AI_INSTRUCTIONS_COPIED_EVENT = 'onboarding_ai_instructions_copied'

interface AiInstructionsCopiedInput {
  appId?: string
  event: string
  nonPersonTags?: Record<string, string | number | boolean>
  orgId?: string
}

const onboardingAttemptIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isFrontendPosthogCapturedEvent(event: string) {
  return event === AI_INSTRUCTIONS_COPIED_EVENT
}

export function buildAiInstructionsCopiedBentoEvent(input: AiInstructionsCopiedInput): BentoTrackingPayload | undefined {
  const attemptId = input.nonPersonTags?.onboarding_attempt_id
  if (!isFrontendPosthogCapturedEvent(input.event)
    || !input.orgId
    || !input.appId
    || typeof attemptId !== 'string'
    || !onboardingAttemptIdPattern.test(attemptId)) {
    return undefined
  }

  const context = input.nonPersonTags ?? {}
  return {
    data: {
      app_id: input.appId,
      onboarding_attempt_id: attemptId,
      org_id: input.orgId,
      ...(typeof context.existing_app === 'boolean' ? { existing_app: context.existing_app } : {}),
      ...(context.flow === 'pre_org' || context.flow === 'existing_org' ? { flow: context.flow } : {}),
      ...(context.intent === 'ota' || context.intent === 'builder' || context.intent === 'both' || context.intent === 'exploring' ? { intent: context.intent } : {}),
      ...(typeof context.onboarding_version === 'number' ? { onboarding_version: context.onboarding_version } : {}),
      ...(typeof context.resumed === 'boolean' ? { resumed: context.resumed } : {}),
      ...(context.setup_command === 'builder' || context.setup_command === 'ota' ? { setup_command: context.setup_command } : {}),
    },
    event: 'app:ai_instructions_copied',
    once: true,
    preferenceKey: 'onboarding',
    uniqId: `app:ai_instructions_copied:${input.appId}:${attemptId}`,
  }
}
