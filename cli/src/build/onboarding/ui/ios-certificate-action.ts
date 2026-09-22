import type { IosEffectResult, IosStepCtx } from '../ios/flow.js'
import type { BuilderOnboardingAction } from '../telemetry.js'
import type { OnboardingStep } from '../types.js'

type TrackAction = (action: BuilderOnboardingAction, tags: Record<string, string>, step: OnboardingStep) => void

function emitCertificateAction(
  trackAction: TrackAction,
  action: BuilderOnboardingAction,
  journeyId: string,
  source: 'created' | 'keychain_import',
  step: OnboardingStep,
  reason?: 'create_failed' | 'certificate_limit' | 'export_failed',
): void {
  try {
    trackAction(action, {
      attempt_id: journeyId,
      source,
      ...(reason ? { reason } : {}),
    }, step)
  }
  catch {
    // Even a synchronous telemetry failure must not interrupt onboarding.
  }
}

export function trackCreatedIosCertificateResult(
  result: IosEffectResult,
  journeyId: string,
  trackAction: TrackAction,
  reportedSuccesses: Set<string>,
): void {
  if (result.next === 'cert-limit-prompt') {
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
  if (reportedSuccesses.has(successKey))
    return
  reportedSuccesses.add(successKey)
  emitCertificateAction(trackAction, 'certificate_prepared', journeyId, 'created', 'creating-certificate')
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
  if (reportedSuccesses.has(successKey))
    return
  reportedSuccesses.add(successKey)
  emitCertificateAction(trackAction, 'certificate_prepared', journeyId, 'keychain_import', 'saving-credentials')
}
