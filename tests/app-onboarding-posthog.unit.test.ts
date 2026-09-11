import { describe, expect, it } from 'vitest'
import { buildAppOnboardingStepPosthogEvent } from '../supabase/functions/_backend/utils/app_onboarding_posthog.ts'

describe('app onboarding step PostHog event', () => {
  it.concurrent('links the committed history entry to its user and organization', () => {
    expect(buildAppOnboardingStepPosthogEvent({
      appId: 'com.example.app',
      auth: { authType: 'jwt', userId: 'user-id', apikey: null, jwt: 'token' },
      change: { stepId: 'build_project', status: 'done', at: '2026-09-11T18:00:00.000Z', historyLength: 3, historyFull: false },
      orgId: 'org-id',
      setup: { source: 'cli', outcome: 'in_progress', steps: {} },
    })).toMatchObject({
      event: 'App Onboarding Step Changed',
      groups: { organization: 'org-id' },
      user_id: 'user-id',
      setPersonProperties: false,
      timestamp: '2026-09-11T18:00:00.000Z',
      nonPersonTags: {
        app_id: 'com.example.app',
        auth_type: 'jwt',
        history_entry_type: 'status',
        history_length: 3,
        onboarding_outcome: 'in_progress',
        onboarding_source: 'cli',
        step_id: 'build_project',
        step_status: 'done',
      },
    })
  })
})
