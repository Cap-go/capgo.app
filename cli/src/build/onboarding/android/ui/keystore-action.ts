import type { AndroidOnboardingProgress, AndroidOnboardingStep } from '../types.js'
import type { PreparationTrackAction } from '../../ui/preparation-action.js'
import { emitPreparationAction, emitPreparationSuccessOnce } from '../../ui/preparation-action.js'

export type AndroidKeystoreSource = 'generated' | 'imported'
export type AndroidKeyPasswordStatus = 'verified' | 'generated_with_keystore' | 'not_checked'
export type AndroidKeystoreFailureReason = 'generate_failed' | 'import_failed'

type TrackAction = PreparationTrackAction<AndroidOnboardingStep>

function hasSavedKeystore(progress: AndroidOnboardingProgress, source: AndroidKeystoreSource): boolean {
  const ready = progress.completedSteps.keystoreReady
  return Boolean(
    ready
    && ready.isGenerated === (source === 'generated')
    && progress._keystoreBase64
    && progress.keystoreAlias
    && progress.keystoreStorePassword
    && progress.keystoreKeyPassword,
  )
}

export function trackPreparedAndroidKeystore(
  progress: AndroidOnboardingProgress,
  source: AndroidKeystoreSource,
  keyPassword: AndroidKeyPasswordStatus,
  journeyId: string,
  trackAction: TrackAction,
  reportedSuccesses: Set<string>,
): boolean {
  if (!hasSavedKeystore(progress, source))
    return false

  emitPreparationSuccessOnce(reportedSuccesses, source, trackAction, {
    action: 'keystore_prepared',
    attemptId: journeyId,
    source,
    step: source === 'generated' ? 'keystore-generating' : 'keystore-existing-key-password',
    tags: { key_password: keyPassword },
  })
  return true
}

export function trackAndroidKeystorePreparationFailure(
  source: AndroidKeystoreSource,
  keyPassword: AndroidKeyPasswordStatus,
  reason: AndroidKeystoreFailureReason,
  journeyId: string,
  trackAction: TrackAction,
): void {
  emitPreparationAction(trackAction, {
    action: 'keystore_preparation_failed',
    attemptId: journeyId,
    source,
    step: source === 'generated' ? 'keystore-generating' : 'keystore-existing-key-password',
    tags: { reason, key_password: keyPassword },
  })
}
