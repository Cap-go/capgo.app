import type { IosEffectResult, IosStepCtx } from '../ios/flow.js'
import type { OnboardingStep } from '../types.js'
import type { PreparationTrackAction } from './preparation-action.js'
import { emitPreparationSuccessOnce } from './preparation-action.js'

type TrackAction = PreparationTrackAction<OnboardingStep>
type CreatedProfileStep = 'creating-profile' | 'import-create-profile-only'

function completeCreatedProfile(result: IosEffectResult, step: CreatedProfileStep): string | null {
  if (step === 'creating-profile') {
    const profile = result.progress.completedSteps.profileCreated
    return result.next === 'saving-credentials'
      && profile?.profileId
      && profile.profileName
      && profile.profileBase64
      ? profile.profileId
      : null
  }

  const profile = result.transient?.chosenProfile as (IosStepCtx['chosenProfile'] & { profileBase64?: string }) | undefined
  return result.next === 'import-export-warning'
    && profile?.uuid
    && profile.name
    && profile.profileBase64
    ? profile.uuid
    : null
}

function emitProfilePrepared(
  profileId: string,
  source: 'created' | 'imported',
  step: CreatedProfileStep | 'import-pick-profile',
  journeyId: string,
  trackAction: TrackAction,
  reportedSuccesses: Set<string>,
): void {
  emitPreparationSuccessOnce(reportedSuccesses, profileId, trackAction, {
    action: 'profile_prepared',
    attemptId: journeyId,
    source,
    step,
  })
}

export function trackCreatedIosProfileResult(
  result: IosEffectResult,
  step: CreatedProfileStep,
  journeyId: string,
  trackAction: TrackAction,
  reportedSuccesses: Set<string>,
): void {
  const profileId = completeCreatedProfile(result, step)
  if (profileId)
    emitProfilePrepared(profileId, 'created', step, journeyId, trackAction, reportedSuccesses)
}

export function trackImportedIosProfileValidationResult(
  result: IosEffectResult,
  carried: Partial<IosStepCtx>,
  journeyId: string,
  trackAction: TrackAction,
  reportedSuccesses: Set<string>,
): void {
  const profile = carried.chosenProfile
  if (result.next !== 'import-export-warning'
    || result.progress.setupMethod !== 'import-existing'
    || !profile?.uuid
    || !profile.name
    || !profile.bundleId
    || !profile.profileType
    || profile.certificateSha1s.length === 0) {
    return
  }

  emitProfilePrepared(profile.uuid, 'imported', 'import-pick-profile', journeyId, trackAction, reportedSuccesses)
}
