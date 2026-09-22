import { describe, expect, it } from 'vitest'
import { buildAppOnboardingStepPosthogEvent } from '../supabase/functions/_backend/utils/app_onboarding_posthog.ts'

describe('app onboarding step PostHog event', () => {
  it.concurrent('links the committed history entry to its user and organization', () => {
    expect(buildAppOnboardingStepPosthogEvent({
      appId: 'com.example.app',
      auth: { authType: 'jwt', userId: 'user-id', apikey: null, jwt: 'token' },
      change: { stepId: 'build_project', status: 'done', at: '2026-09-11T18:00:00.000Z', historyLength: 3, historyFull: false },
      orgId: 'org-id',
      setup: { todo_list_version: 2, source: 'cli', outcome: 'in_progress', steps: {} },
    })).toMatchObject({
      event: 'App Onboarding Step Changed',
      groups: { organization: 'org-id' },
      user_id: 'user-id',
      setPersonProperties: false,
      timestamp: '2026-09-11T18:00:00.000Z',
      nonPersonTags: {
        $insert_id: 'app-onboarding-step:com.example.app:build_project:2026-09-11T18:00:00.000Z:3',
        app_id: 'com.example.app',
        auth_type: 'jwt',
        history_entry_type: 'status',
        history_length: 3,
        onboarding_outcome: 'in_progress',
        onboarding_source: 'cli',
        todo_list_version: 2,
        step_id: 'build_project',
        step_status: 'done',
      },
    })
  })

  it.concurrent('attributes queue observations to the app rather than a human', () => {
    expect(buildAppOnboardingStepPosthogEvent({
      appId: 'com.example.app',
      system: true,
      change: { stepId: 'run_device', status: 'done', at: '2026-09-11T18:00:00.000Z', historyLength: 1, historyFull: false },
      orgId: 'org-id',
      setup: { todo_list_version: 4, ota_todo_list_version: '1', source: 'manual', outcome: 'in_progress', steps: {} },
    })).toMatchObject({
      distinct_id: 'app-onboarding-app:com.example.app',
      setPersonProperties: false,
      nonPersonTags: { auth_type: 'system', step_id: 'run_device', todo_list_version: 4 },
    })
  })
})
