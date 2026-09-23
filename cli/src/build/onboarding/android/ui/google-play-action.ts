import type { ValidationResult } from '../service-account-validation.js'
import type { AndroidOnboardingProgress, AndroidOnboardingStep } from '../types.js'
import type { PreparationTrackAction } from '../../ui/preparation-action.js'
import { emitPreparationAction, emitPreparationSuccessOnce } from '../../ui/preparation-action.js'

export type GooglePlayConnectionSource = 'imported_service_account' | 'generated_service_account'
export type GooglePlayConnectionFailureReason
  = | 'shape_error'
    | 'file_read_error'
    | 'token_error'
    | 'no_app_access'
    | 'network_error'
    | 'missing_scopes'
    | 'oauth_failed'
    | 'provisioning_failed'

type FailedValidationKind = Extract<ValidationResult, { ok: false }>['kind']
type ImportedGooglePlayFailureKind = FailedValidationKind | 'file-read-error'
type TrackAction = PreparationTrackAction<AndroidOnboardingStep>

const validationFailureReasons: Record<ImportedGooglePlayFailureKind, GooglePlayConnectionFailureReason> = {
  'file-read-error': 'file_read_error',
  'shape-error': 'shape_error',
  'token-error': 'token_error',
  'no-app-access': 'no_app_access',
  'network-error': 'network_error',
}

function hasSavedGooglePlayConnection(
  progress: AndroidOnboardingProgress,
  source: GooglePlayConnectionSource,
): boolean {
  if (source === 'imported_service_account') {
    return Boolean(
      progress._serviceAccountKeyBase64
      && progress.serviceAccountValidationSkipped === false,
    )
  }

  return Boolean(
    progress._serviceAccountKeyBase64
    && progress.completedSteps.serviceAccountProvisioned
    && progress.completedSteps.playInviteProvisioned,
  )
}

export function trackConnectedGooglePlay(
  progress: AndroidOnboardingProgress,
  source: GooglePlayConnectionSource,
  journeyId: string,
  trackAction: TrackAction,
  reportedSuccesses: Set<string>,
): boolean {
  if (!hasSavedGooglePlayConnection(progress, source))
    return false

  emitPreparationSuccessOnce(reportedSuccesses, source, trackAction, {
    action: 'google_play_connected',
    attemptId: journeyId,
    source,
    step: source === 'imported_service_account' ? 'sa-json-validating' : 'gcp-setup-running',
  })
  return true
}

export function trackImportedGooglePlayValidationFailure(
  kind: ImportedGooglePlayFailureKind,
  journeyId: string,
  trackAction: TrackAction,
): void {
  trackGooglePlayConnectionFailure(
    'imported_service_account',
    validationFailureReasons[kind],
    'sa-json-validating',
    journeyId,
    trackAction,
  )
}

export function trackGooglePlayConnectionFailure(
  source: GooglePlayConnectionSource,
  reason: GooglePlayConnectionFailureReason,
  step: AndroidOnboardingStep,
  journeyId: string,
  trackAction: TrackAction,
): void {
  emitPreparationAction(trackAction, {
    action: 'google_play_connection_failed',
    attemptId: journeyId,
    source,
    step,
    tags: { reason },
  })
}

export function trackUnverifiedGooglePlayConnection(
  journeyId: string,
  trackAction: TrackAction,
): void {
  emitPreparationAction(trackAction, {
    action: 'google_play_connection_unverified',
    attemptId: journeyId,
    source: 'imported_service_account',
    step: 'sa-json-validation-failed',
    tags: { reason: 'validation_skipped' },
  })
}

export function trackGeneratedGooglePlayProvisioningFailure(
  savedProgress: AndroidOnboardingProgress | null,
  journeyId: string,
  trackAction: TrackAction,
  reportedSuccesses: Set<string>,
): boolean {
  if (savedProgress && trackConnectedGooglePlay(
    savedProgress,
    'generated_service_account',
    journeyId,
    trackAction,
    reportedSuccesses,
  )) {
    return true
  }

  trackGooglePlayConnectionFailure(
    'generated_service_account',
    'provisioning_failed',
    'gcp-setup-running',
    journeyId,
    trackAction,
  )
  return false
}
