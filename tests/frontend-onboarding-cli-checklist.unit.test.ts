import { describe, expect, it } from 'vitest'
import {
  buildFrontendOnboardingCliChecklistCoverage,
} from '../supabase/functions/_backend/utils/frontend_onboarding_cli_checklist.ts'

describe('frontend onboarding CLI checklist coverage', () => {
  it.concurrent('counts persisted done and skipped states for unique active linked apps', () => {
    const coverage = buildFrontendOnboardingCliChecklistCoverage([
      'com.example.one',
      'com.example.one',
      'com.example.two',
      'com.example.v2',
      'com.example.deleted',
      '',
    ], [{
      appId: 'com.example.one',
      onboarding: {
        setup: {
          todo_list_version: 1,
          steps: {
            add_app: { status: 'done' },
            add_channel: { status: 'skipped' },
          },
        },
      },
    }, {
      appId: 'com.example.two',
      onboarding: {
        setup: {
          todo_list_version: 1,
          steps: {
            add_app: { status: 'done' },
            add_channel: { status: 'unknown' },
          },
        },
      },
    }, {
      appId: 'com.example.v2',
      onboarding: {
        setup: {
          todo_list_version: 2,
          steps: { login_cli_mcp: { status: 'done' } },
        },
      },
    }, {
      appId: 'com.example.unlinked',
      onboarding: { steps: { add_app: { status: 'done' } } },
    }])

    expect(coverage).toMatchObject({ linked_apps: 3, active_apps: 2, unavailable_apps: 1 })
    expect(coverage.steps[0]).toEqual({
      step_id: 'add_app',
      done: 2,
      skipped: 0,
      done_percent: 100,
    })
    expect(coverage.steps[1]).toEqual({
      step_id: 'add_channel',
      done: 0,
      skipped: 1,
      done_percent: 0,
    })
    expect(coverage.steps).toHaveLength(12)
  })

  it.concurrent('returns the complete empty checklist when no linked apps exist', () => {
    const coverage = buildFrontendOnboardingCliChecklistCoverage([], [])

    expect(coverage).toMatchObject({ linked_apps: 0, active_apps: 0, unavailable_apps: 0 })
    expect(coverage.steps).toHaveLength(12)
    expect(coverage.steps.every(step => step.done_percent === 0)).toBe(true)
  })
})
