import { describe, expect, it, vi } from 'vitest'
import {
  createOnboardingProgressTracker,
  ONBOARDING_ANALYTICS_VERSION,
} from '../src/utils/onboardingProgressAnalytics'

const steps = ['intent', 'details', 'organization', 'setup'] as const

describe('onboarding progress analytics', () => {
  it.concurrent('reports the initial real step with the stable version and approved properties', () => {
    const capture = vi.fn()
    const tracker = createOnboardingProgressTracker({
      capture,
      flow: 'pre_org',
      now: () => 100,
      resumed: false,
      steps,
      supaHost: 'https://supabase.capgo.test',
    })

    tracker.viewStep('intent')

    expect(ONBOARDING_ANALYTICS_VERSION).toBe(2)
    expect(capture).toHaveBeenCalledOnce()
    expect(capture).toHaveBeenCalledWith(
      'onboarding_step_viewed',
      'https://supabase.capgo.test',
      {
        flow: 'pre_org',
        onboarding_attempt_id: expect.any(String),
        onboarding_version: ONBOARDING_ANALYTICS_VERSION,
        resumed: false,
        step: 'intent',
        step_index: 0,
        total_steps: 4,
      },
    )
  })

  it.concurrent('uses one unique attempt id for every event from a tracker instance', () => {
    const firstCapture = vi.fn()
    const firstTracker = createOnboardingProgressTracker({
      capture: firstCapture,
      flow: 'pre_org',
      resumed: false,
      steps,
      supaHost: 'https://supabase.capgo.test',
    })
    const secondCapture = vi.fn()
    const secondTracker = createOnboardingProgressTracker({
      capture: secondCapture,
      flow: 'pre_org',
      resumed: false,
      steps,
      supaHost: 'https://supabase.capgo.test',
    })

    firstTracker.viewStep('intent')
    firstTracker.completeStep('intent', { nextStep: 'details' })
    secondTracker.viewStep('intent')

    const firstAttemptIds = firstCapture.mock.calls.map(call => call[2]?.onboarding_attempt_id)
    const secondAttemptId = secondCapture.mock.calls[0]?.[2]?.onboarding_attempt_id
    expect(firstAttemptIds[0]).toEqual(expect.any(String))
    expect(new Set(firstAttemptIds).size).toBe(1)
    expect(firstAttemptIds[0]).not.toBe(secondAttemptId)
  })

  it.concurrent('reports completion before the next view with duration and narrow context', () => {
    let now = 1_000
    const capture = vi.fn()
    const tracker = createOnboardingProgressTracker({
      capture,
      flow: 'pre_org',
      now: () => now,
      resumed: false,
      steps,
      supaHost: 'https://supabase.capgo.test',
    })

    tracker.viewStep('intent')
    now = 1_125.9
    tracker.completeStep('intent', { intent: 'ota', nextStep: 'details' })
    tracker.viewStep('details', 'intent')

    expect(capture.mock.calls.map(call => call[0])).toEqual([
      'onboarding_step_viewed',
      'onboarding_step_completed',
      'onboarding_step_viewed',
    ])
    expect(capture.mock.calls[1]?.[2]).toEqual({
      duration_ms: 125,
      flow: 'pre_org',
      intent: 'ota',
      next_step: 'details',
      onboarding_attempt_id: expect.any(String),
      onboarding_version: ONBOARDING_ANALYTICS_VERSION,
      resumed: false,
      step: 'intent',
      step_index: 0,
      total_steps: 4,
    })
    expect(capture.mock.calls[2]?.[2]).toEqual({
      flow: 'pre_org',
      onboarding_attempt_id: expect.any(String),
      onboarding_version: ONBOARDING_ANALYTICS_VERSION,
      previous_step: 'intent',
      resumed: false,
      step: 'details',
      step_index: 1,
      total_steps: 4,
    })
  })

  it.concurrent('associates app-details interaction events with the active onboarding attempt', () => {
    const capture = vi.fn()
    const tracker = createOnboardingProgressTracker({
      capture,
      flow: 'pre_org',
      resumed: false,
      steps,
      supaHost: 'https://supabase.capgo.test',
    })

    tracker.trackDetailsEvent('onboarding_app_name_entered', { app_name: 'Example App' })

    expect(capture).toHaveBeenCalledWith(
      'onboarding_app_name_entered',
      'https://supabase.capgo.test',
      expect.objectContaining({
        app_name: 'Example App',
        flow: 'pre_org',
        onboarding_attempt_id: expect.any(String),
        onboarding_version: 2,
        step: 'details',
      }),
    )
  })

  it.concurrent('deduplicates completion for one visit and resets timing after back navigation', () => {
    let now = 10
    const capture = vi.fn()
    const tracker = createOnboardingProgressTracker({
      capture,
      flow: 'existing_org',
      now: () => now,
      resumed: true,
      steps: ['details', 'choice', 'install'],
      supaHost: 'https://supabase.capgo.test',
    })

    tracker.viewStep('choice')
    now = 20
    tracker.completeStep('choice', { nextStep: 'install' })
    tracker.completeStep('choice', { nextStep: 'install' })
    tracker.viewStep('install', 'choice')
    now = 50
    tracker.viewStep('choice', 'install')
    now = 65
    tracker.completeStep('choice', { nextStep: 'install' })

    const completed = capture.mock.calls.filter(call => call[0] === 'onboarding_step_completed')
    expect(completed).toHaveLength(2)
    expect(completed[0]?.[2]).toMatchObject({ duration_ms: 10, resumed: true })
    expect(completed[1]?.[2]).toMatchObject({
      duration_ms: 15,
      previous_step: 'install',
      resumed: true,
    })
  })

  it.concurrent('tracks a resumed setup visit through its terminal completion', () => {
    const capture = vi.fn()
    const tracker = createOnboardingProgressTracker({
      capture,
      flow: 'existing_org',
      now: () => 50,
      resumed: true,
      steps: ['details', 'choice', 'install', 'setup'],
      supaHost: 'https://supabase.capgo.test',
    })

    tracker.viewStep('setup')
    tracker.completeStep('setup', { appId: 'com.example.final' })

    expect(capture.mock.calls.map(call => call[0])).toEqual([
      'onboarding_step_viewed',
      'onboarding_step_completed',
    ])
    expect(capture.mock.calls[0]?.[2]).toMatchObject({
      resumed: true,
      step: 'setup',
      step_index: 3,
      total_steps: 4,
    })
    expect(capture.mock.calls[1]?.[2]).toMatchObject({
      app_id: 'com.example.final',
      resumed: true,
      step: 'setup',
    })
  })

  it.concurrent('ignores completion without a matching active visit', () => {
    const capture = vi.fn()
    const tracker = createOnboardingProgressTracker({
      capture,
      flow: 'existing_org',
      steps: ['details', 'choice', 'install'],
      resumed: false,
      supaHost: 'https://supabase.capgo.test',
    })

    tracker.completeStep('details', { nextStep: 'choice' })
    tracker.viewStep('details')
    tracker.completeStep('choice', { nextStep: 'install' })

    expect(capture).toHaveBeenCalledOnce()
    expect(capture.mock.calls[0]?.[0]).toBe('onboarding_step_viewed')
  })

  it.concurrent('never exposes free-text fields and never lets capture failures escape', () => {
    const capture = vi.fn<(
      name: string,
      supaHost: string,
      properties?: Record<string, string | number | boolean | null>,
    ) => void>(() => {
      throw new Error('PostHog unavailable')
    })
    const tracker = createOnboardingProgressTracker({
      capture,
      flow: 'existing_org',
      steps: ['details', 'choice', 'install'],
      resumed: false,
      supaHost: 'https://supabase.capgo.test',
    })

    expect(() => tracker.viewStep('details')).not.toThrow()
    expect(() => tracker.completeStep('details', {
      appId: 'com.example.final',
      nextStep: 'choice',
      storeImportUsed: true,
    })).not.toThrow()

    const allowedKeys = new Set([
      'app_id',
      'duration_ms',
      'flow',
      'intent',
      'next_step',
      'onboarding_attempt_id',
      'onboarding_version',
      'previous_step',
      'resumed',
      'step',
      'step_index',
      'store_import_used',
      'total_steps',
    ])
    for (const call of capture.mock.calls) {
      expect(Object.keys(call[2] ?? {}).every(key => allowedKeys.has(key))).toBe(true)
    }
  })
})
