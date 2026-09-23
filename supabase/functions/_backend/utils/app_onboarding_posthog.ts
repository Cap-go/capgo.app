import type { AppOnboardingState, AppOnboardingStepHistoryChange } from './appOnboarding.ts'
import type { AuthInfo } from './hono.ts'

interface AppOnboardingStepPosthogInput {
  appId: string
  change: AppOnboardingStepHistoryChange
  orgId: string
  setup: AppOnboardingState
}

export function buildAppOnboardingStepPosthogEvent(input: AppOnboardingStepPosthogInput & ({ auth: AuthInfo, system?: false } | { auth?: never, system: true })) {
  return {
    channel: 'app-onboarding',
    event: 'App Onboarding Step Changed',
    groups: { organization: input.orgId },
    ...(input.system ? { distinct_id: `app-onboarding-app:${input.appId}`, timeoutMs: 3000 } : { user_id: input.auth.userId }),
    setPersonProperties: false,
    timestamp: input.change.at,
    nonPersonTags: {
      $insert_id: `app-onboarding-step:${input.appId}:${input.change.stepId}:${input.change.at}:${input.change.historyLength}`,
      app_id: input.appId,
      auth_type: input.system ? 'system' : input.auth.authType,
      history_entry_type: input.change.historyFull ? 'update_history_full' : 'status',
      history_length: input.change.historyLength,
      onboarding_outcome: input.setup.outcome,
      onboarding_source: input.setup.source,
      todo_list_version: input.setup.todo_list_version,
      step_id: input.change.stepId,
      step_status: input.change.status,
    },
  }
}
