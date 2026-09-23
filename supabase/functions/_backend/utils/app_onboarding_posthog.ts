import type { Context } from 'hono'
import type { AppOnboardingState, AppOnboardingStepHistoryChange } from './appOnboarding.ts'
import type { AppOnboardingMutationResult } from './appOnboardingMutation.ts'
import type { AuthInfo, MiddlewareKeyVariables } from './hono.ts'
import { parseAppOnboarding } from './appOnboarding.ts'
import { trackPosthogEvent } from './posthog.ts'
import { backgroundTask } from './utils.ts'

interface AppOnboardingStepPosthogInput {
  appId: string
  change: AppOnboardingStepHistoryChange
  orgId: string
  setup: AppOnboardingState
}

// Call only after the transaction owning these mutations has committed.
export async function emitCommittedAppOnboardingHistory(c: Context<MiddlewareKeyVariables>, committed: AppOnboardingMutationResult[]) {
  const events = committed.flatMap(result => result.historyChanges.map(change => buildAppOnboardingStepPosthogEvent({
    appId: result.appId,
    orgId: result.orgId,
    auth: c.get('auth')!,
    setup: parseAppOnboarding(result.onboarding),
    change,
  })))
  if (events.length)
    await backgroundTask(c, Promise.all(events.map(event => trackPosthogEvent(c, event))))
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
