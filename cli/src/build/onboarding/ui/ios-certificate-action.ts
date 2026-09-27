import type { IosEffectResult, IosStepCtx } from '../ios/flow.js'
import type { OnboardingStep } from '../types.js'
import type { PreparationTrackAction } from './preparation-action.js'
import { emitPreparationAction, emitPreparationSuccessOnce } from './preparation-action.js'

type TrackAction = PreparationTrackAction<OnboardingStep>

function emitCertificateAction(
  trackAction: TrackAction,
  action: 'certificate_prepared' | 'certificate_preparation_failed',
  journeyId: string,
  source: 'created' | 'keychain_import',
  step: OnboardingStep,
  reason?: 'create_failed' | 'certificate_limit' | 'export_failed',
): void {
  emitPreparationAction(trackAction, {
    action,
    attemptId: journeyId,
    source,
    step,
    tags: reason ? { reason } : undefined,
  })
}

export function trackCreatedIosCertificateResult(
  result: IosEffectResult,
  journeyId: string,
  trackAction: TrackAction,
  reportedSuccesses: Set<string>,
): void {
  if (result.next === 'cert-limit-prompt' || result.transient?.certificateLimitReached) {
    emitCertificateAction(trackAction, 'certificate_preparation_failed', journeyId, 'created', 'creating-certificate', 'certificate_limit')
    return
  }
  if (result.next === 'error') {
    emitCertificateAction(trackAction, 'certificate_preparation_failed', journeyId, 'created', 'creating-certificate', 'create_failed')
    return
  }

  const cert = result.progress.completedSteps.certificateCreated
  if (result.next !== 'creating-profile' || !cert?.certificateId || !cert.p12Base64)
    return

  const successKey = `created:${cert.certificateId}`
  emitPreparationSuccessOnce(reportedSuccesses, successKey, trackAction, {
    action: 'certificate_prepared',
    attemptId: journeyId,
    source: 'created',
    step: 'creating-certificate',
  })
}

export function trackIosCertificateCreationThrow(journeyId: string, trackAction: TrackAction): void {
  emitCertificateAction(trackAction, 'certificate_preparation_failed', journeyId, 'created', 'creating-certificate', 'create_failed')
}

export function trackIosKeychainExportResult(result: IosEffectResult, journeyId: string, trackAction: TrackAction): void {
  if (result.next === 'error' && result.transient?.keychainP12ExportFailed)
    emitCertificateAction(trackAction, 'certificate_preparation_failed', journeyId, 'keychain_import', 'import-exporting', 'export_failed')
}

export function trackImportedIosCertificateSaveResult(
  result: IosEffectResult,
  carried: Partial<IosStepCtx>,
  journeyId: string,
  trackAction: TrackAction,
  reportedSuccesses: Set<string>,
): void {
  if (result.progress.setupMethod !== 'import-existing' || result.next !== 'ask-build' || !result.transient?.savedCredentials || !carried.keychainP12Exported || !carried.certData?.p12Base64)
    return

  const successKey = `keychain_import:${carried.chosenIdentity?.sha1 ?? ''}`
  emitPreparationSuccessOnce(reportedSuccesses, successKey, trackAction, {
    action: 'certificate_prepared',
    attemptId: journeyId,
    source: 'keychain_import',
    step: 'saving-credentials',
  })
}
