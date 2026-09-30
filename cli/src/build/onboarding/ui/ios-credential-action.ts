import type { IosEffectResult } from '../ios/flow.js'
import type { BuilderOnboardingAction } from '../telemetry.js'
import type { OnboardingStep } from '../types.js'
import { mapIosOnboardingError } from '../error-categories.js'

type TrackAction = (action: BuilderOnboardingAction, tags: Record<string, string>, step: OnboardingStep) => void

function credentialTags(journeyId: string): Record<string, string> {
  return { credential: 'ios_app_store_connect_api_key', attempt_id: journeyId }
}

export function trackGuidedKeyValidationFailure(
  eventName: string,
  journeyId: string,
  trackAction: TrackAction,
  cancelled = false,
): void {
  if (cancelled || eventName !== 'validation_failed')
    return

  trackAction('credential_verification_failed', {
    ...credentialTags(journeyId),
    source: 'guided_helper',
  }, 'asc-key-generating')
}

export async function verifyIosKeyWithTelemetry<T>(
  verify: () => Promise<T>,
  journeyId: string,
  trackAction: TrackAction,
  isCancelled: () => boolean,
): Promise<T> {
  try {
    return await verify()
  }
  catch (error) {
    if (!isCancelled()) {
      trackAction('credential_verification_failed', {
        ...credentialTags(journeyId),
        source: 'cli_verifier',
        error_category: mapIosOnboardingError(error, 'verifying-key'),
      }, 'verifying-key')
    }
    throw error
  }
}

export function trackVerifiedIosKey(
  result: IosEffectResult,
  journeyId: string,
  trackAction: TrackAction,
): void {
  if (result.next === 'error' || !result.progress.completedSteps.apiKeyVerified)
    return

  trackAction('credential_verified', credentialTags(journeyId), 'verifying-key')
}
