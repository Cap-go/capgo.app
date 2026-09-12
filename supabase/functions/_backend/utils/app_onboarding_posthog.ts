import type { AuthInfo } from './hono.ts'
import type { AppOnboardingState, AppOnboardingStepHistoryChange } from './appOnboarding.ts'

interface AppOnboardingStepPosthogInput {
  appId: string
  auth: AuthInfo
  change: AppOnboardingStepHistoryChange
  orgId: string
  setup: AppOnboardingState
}

export function buildAppOnboardingStepPosthogEvent(input: AppOnboardingStepPosthogInput) {
  return {
    channel: 'app-onboarding',
    event: 'App Onboarding Step Changed',
    groups: { organization: input.orgId },
    user_id: input.auth.userId,
    setPersonProperties: false,
    timestamp: input.change.at,
    nonPersonTags: {
      $insert_id: `app-onboarding-step:${input.appId}:${input.change.stepId}:${input.change.at}:${input.change.historyLength}`,
      app_id: input.appId,
      auth_type: input.auth.authType,
      history_entry_type: input.change.historyFull ? 'update_history_full' : 'status',
      history_length: input.change.historyLength,
      onboarding_outcome: input.setup.outcome,
      onboarding_source: input.setup.source,
      step_id: input.change.stepId,
      step_status: input.change.status,
    },
  }
}
