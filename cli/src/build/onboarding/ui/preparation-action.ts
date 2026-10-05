import type { BuilderOnboardingAction } from '../telemetry.js'

export type PreparationTrackAction<TStep extends string> = (
  action: BuilderOnboardingAction,
  tags: Record<string, string>,
  step: TStep,
) => void

interface PreparationActionInput<TStep extends string> {
  action: BuilderOnboardingAction
  attemptId: string
  source: string
  step: TStep
  tags?: Record<string, string>
}

export function emitPreparationAction<TStep extends string>(
  trackAction: PreparationTrackAction<TStep>,
  input: PreparationActionInput<TStep>,
): void {
  try {
    trackAction(input.action, {
      attempt_id: input.attemptId,
      source: input.source,
      ...input.tags,
    }, input.step)
  }
  catch {
    // Even a synchronous telemetry failure must not interrupt onboarding.
  }
}

export function emitPreparationSuccessOnce<TStep extends string>(
  reportedSuccesses: Set<string>,
  successKey: string,
  trackAction: PreparationTrackAction<TStep>,
  input: PreparationActionInput<TStep>,
): void {
  if (reportedSuccesses.has(successKey))
    return
  reportedSuccesses.add(successKey)
  emitPreparationAction(trackAction, input)
}
