import { describe, expect, it } from 'vitest'
import { buildBuilderOnboardingBentoEvent } from '../supabase/functions/_backend/utils/builder_onboarding_recovery.ts'

const base = { orgId: 'org-1', appId: 'com.demo.app', platform: 'ios', orgName: 'Demo Org', appName: 'Demo' }

describe('buildBuilderOnboardingBentoEvent', () => {
  it.concurrent('returns a started payload on the welcome step', () => {
    const r = buildBuilderOnboardingBentoEvent({ event: 'Builder Onboarding Step', step: 'welcome', ...base })
    expect(r).toBeDefined()
    expect(r!.event).toBe('builder_onboarding_started')
    expect(r!.preferenceKey).toBe('builder_onboarding')
    expect(r!.cron).toBe('* * * * *')
    expect(r!.uniqId).toBe('builder_onboarding_started:com.demo.app:ios')
    expect(r!.data).toMatchObject({
      org_id: 'org-1',
      org_name: 'Demo Org',
      app_id: 'com.demo.app',
      app_name: 'Demo',
      platform: 'ios',
      step: 'welcome',
    })
  })

  it.concurrent('returns a completed payload on build-complete', () => {
    const r = buildBuilderOnboardingBentoEvent({ event: 'Builder Onboarding Step', step: 'build-complete', ...base })
    expect(r!.event).toBe('builder_onboarding_completed')
    expect(r!.uniqId).toBe('builder_onboarding_completed:com.demo.app:ios')
  })

  it.concurrent('returns undefined for non-milestone steps', () => {
    expect(buildBuilderOnboardingBentoEvent({ event: 'Builder Onboarding Step', step: 'verifying-key', ...base })).toBeUndefined()
  })

  it.concurrent('returns undefined for other event names', () => {
    expect(buildBuilderOnboardingBentoEvent({ event: 'onboarding-step-done', step: 'welcome', ...base })).toBeUndefined()
  })

  it.concurrent('returns undefined when org or app id is missing', () => {
    expect(buildBuilderOnboardingBentoEvent({ ...base, event: 'Builder Onboarding Step', step: 'welcome', orgId: undefined })).toBeUndefined()
    expect(buildBuilderOnboardingBentoEvent({ ...base, event: 'Builder Onboarding Step', step: 'welcome', appId: undefined })).toBeUndefined()
  })

  it.concurrent('defaults platform to "unknown" when absent', () => {
    const r = buildBuilderOnboardingBentoEvent({ ...base, event: 'Builder Onboarding Step', step: 'welcome', platform: undefined })
    expect(r!.uniqId).toBe('builder_onboarding_started:com.demo.app:unknown')
    expect(r!.data.platform).toBe('unknown')
  })
})
