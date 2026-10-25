import { describe, expect, it, vi } from 'vitest'
import { consumeProfileOnboardingHandoff, initialProfileOnboardingSteps, needsInitialOnboardingName, PROFILE_ONBOARDING_HANDOFF_KEY, readProfileOnboardingHandoff } from '../src/utils/onboardingProfile'

const onboarding = {}

describe('required initial onboarding name', () => {
  it.each([['', ''], ['Alice', ''], ['', 'Smith'], [' ', 'Smith']])('requires both saved names for every new self-signup (%s, %s)', (first_name, last_name) => {
    expect(needsInitialOnboardingName({ first_name, last_name, onboarding })).toBe(true)
  })
  it('requires saved confirmation but excludes invitations and existing organization members', () => {
    expect(needsInitialOnboardingName({ first_name: 'Alice', last_name: 'Smith', onboarding })).toBe(true)
    expect(needsInitialOnboardingName({ first_name: 'Alice', last_name: 'Smith', onboarding: { ...onboarding, profile_completed_at: '2026-10-19T11:00:00Z' } })).toBe(false)
    expect(needsInitialOnboardingName({ created_via_invite: true, onboarding })).toBe(false)
    expect(needsInitialOnboardingName({ onboarding }, true)).toBe(false)
    expect(needsInitialOnboardingName(undefined)).toBe(false)
  })
  it.each([{}, { version: 4 }, { abtests: { onboarding_v6: { branch: 'B', assigned_at: '2026-10-19' } } }])('requires names regardless of stored version or experiment data: %j', (stored) => {
    expect(needsInitialOnboardingName({ onboarding: stored })).toBe(true)
  })
  it('tracks welcome before names and then the goal', () => {
    expect(initialProfileOnboardingSteps(onboarding, true)).toEqual(['welcome', 'name', 'intent', 'app_name', 'app_icon', 'organization', 'setup'])
  })
  it('shares the name, goal and app step order with combined onboarding flags', () => {
    // The retired development-environment assignment no longer adds a step.
    expect(initialProfileOnboardingSteps({ abtests: { webnativeapp_development_environment: { branch: 'C' }, new_channel: { branch: 'A' } } }, true))
      .toEqual(['welcome', 'name', 'intent', 'app_name', 'app_icon', 'organization', 'channel', 'setup'])
  })
  it('consumes the handoff once so a refresh starts a new telemetry run', () => {
    const identity = { attemptId: 'attempt', runId: 'run' }
    let state: Record<string, unknown> = { position: 3, [PROFILE_ONBOARDING_HANDOFF_KEY]: identity }
    const history = {
      get state() {
        return state
      },
      replaceState: vi.fn((next: Record<string, unknown>) => {
        state = next
      }),
    }
    expect(consumeProfileOnboardingHandoff(history)).toEqual(identity)
    expect(state).toEqual({ position: 3 })
    expect(consumeProfileOnboardingHandoff(history)).toBeNull()
    expect(history.replaceState).toHaveBeenCalledTimes(1)
  })
  it('carries the same attempt and run into the app onboarding funnel', () => {
    const identity = { attemptId: 'attempt', runId: 'run' }
    expect(readProfileOnboardingHandoff({ [PROFILE_ONBOARDING_HANDOFF_KEY]: identity })).toEqual(identity)
    expect(readProfileOnboardingHandoff(null)).toBeNull()
    expect(readProfileOnboardingHandoff({ [PROFILE_ONBOARDING_HANDOFF_KEY]: { attemptId: 1 } })).toBeNull()
  })
})
