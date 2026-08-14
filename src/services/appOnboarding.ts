export type {
  AppOnboardingOutcome,
  AppOnboardingPatch,
  AppOnboardingSource,
  AppOnboardingState,
  AppOnboardingStepId,
  AppOnboardingStepState,
  AppOnboardingStepStatus,
} from '../../supabase/functions/_backend/utils/appOnboarding.ts'

export {
  APP_ONBOARDING_STEP_IDS,
  applyAppOnboardingPatch,
  defaultAppOnboarding,
  deriveAppOnboardingOutcome,
  isAppOnboardingOutcome,
  isAppOnboardingSource,
  isAppOnboardingStepId,
  mergeAppOnboarding,
  parseAppOnboarding,
  parseAppOnboardingPatch,
  pickAppOnboardingSource,
} from '../../supabase/functions/_backend/utils/appOnboarding.ts'
