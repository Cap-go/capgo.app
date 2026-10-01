export type {
  AppOnboardingStepId,
  AppOnboardingStepStatus,
} from '../../supabase/functions/_backend/utils/appOnboarding.ts'

export {
  APP_ONBOARDING_OTA_V1_STEP_IDS,
  getAppOnboardingStepIds,
  hasSupportedOtaTodoList,
  parseAppOnboarding,
} from '../../supabase/functions/_backend/utils/appOnboarding.ts'
