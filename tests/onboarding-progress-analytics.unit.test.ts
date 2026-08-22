import { describe, expect, it, vi } from 'vitest'
import {
  createOnboardingProgressTracker,
  createOnboardingTelemetryIdentity,
  ONBOARDING_ANALYTICS_VERSION,
  resolveOnboardingAppIconSource,
} from '../src/utils/onboardingProgressAnalytics'

const steps = ['intent', 'details', 'organization', 'setup'] as const
const ATTEMPT_A1 = '7e64f484-4171-47b6-86f7-0ef5d49e0ef8'
const ATTEMPT_A2 = '89c8aa2f-78df-4ee5-a78d-ef540f33aa43'
const RUN_R1 = 'ir_6b735b41-f8ea-45b9-a46e-10c8be795276'
const RUN_R2_UUID = '9f6a0407-64f9-4696-b447-8dd976674b5c'
const RUN_R2 = `ir_${RUN_R2_UUID}`
const trackerIdentity = {
  onboardingAttemptId: ATTEMPT_A1,
  onboardingRunId: RUN_R1,
}

describe('onboarding progress analytics', () => {
  it.concurrent('classifies restored draft icon data as a file source', () => {
    expect(resolveOnboardingAppIconSource({
      canUseStoreImportPreview: true,
      hasSelectedIconFile: false,
      localIconPreview: 'data:image/png;base64,restored-icon',
    })).toBe('file')

    expect(resolveOnboardingAppIconSource({
      canUseStoreImportPreview: true,
      hasSelectedIconFile: false,
      localIconPreview: 'https://capgo.test/restored-icon.png',
    })).toBe('store')

    expect(resolveOnboardingAppIconSource({
      canUseStoreImportPreview: false,
      hasSelectedIconFile: false,
      localIconPreview: '',
    })).toBe('none')
  })

  it.concurrent('keeps the resumed attempt while continuing from saved progress', () => {
    const capture = vi.fn()
    const ids = [ATTEMPT_A2, RUN_R2_UUID]
    const identity = createOnboardingTelemetryIdentity({
      capture,
      flow: 'pre_org',
      idFactory: () => ids.shift()!,
      supaHost: 'https://supabase.capgo.test',
    })
    identity.prepareResumeCandidate({
      lastRunId: RUN_R1,
      onboardingAttemptId: ATTEMPT_A1,
      savedStep: 'organization',
      steps,
    })

    identity.recordResumeDialogViewed()
    identity.recordResumeDialogViewed()
    identity.recordResumeContinued()
    identity.recordResumeContinued()

    expect(capture.mock.calls.map(call => call[0])).toEqual([
      'onboarding_resume_dialog_viewed',
      'onboarding_resume_continued',
    ])
    expect(capture.mock.calls[0]?.[2]).toEqual({
      flow: 'pre_org',
      onboarding_attempt_id: ATTEMPT_A2,
      onboarding_run_id: RUN_R2,
      onboarding_version: ONBOARDING_ANALYTICS_VERSION,
      resume_onboarding_attempt_id: ATTEMPT_A1,
      resumed_from_run_id: RUN_R1,
      saved_step: 'organization',
      step_index: 2,
      total_steps: 4,
    })
    expect(capture.mock.calls[1]?.[2]).toEqual({
      flow: 'pre_org',
      initial_onboarding_attempt_id: ATTEMPT_A2,
      onboarding_attempt_id: ATTEMPT_A1,
      onboarding_run_id: RUN_R2,
      onboarding_version: ONBOARDING_ANALYTICS_VERSION,
      resume_onboarding_attempt_id: ATTEMPT_A1,
      resumed_from_run_id: RUN_R1,
      saved_step: 'organization',
      step_index: 2,
      total_steps: 4,
    })
    expect(identity.attemptId).toBe(ATTEMPT_A1)
    expect(identity.runId).toBe(RUN_R2)
    expect(identity.getProgressMetadata()).toEqual({
      lastRunId: RUN_R2,
      onboardingAttemptId: ATTEMPT_A1,
    })
  })

  it.concurrent('keeps the fresh attempt when restarting saved progress', () => {
    const capture = vi.fn()
    const ids = [ATTEMPT_A2, RUN_R2_UUID]
    const identity = createOnboardingTelemetryIdentity({
      capture,
      flow: 'pre_org',
      idFactory: () => ids.shift()!,
      supaHost: 'https://supabase.capgo.test',
    })
    identity.prepareResumeCandidate({
      lastRunId: RUN_R1,
      onboardingAttemptId: ATTEMPT_A1,
      savedStep: 'organization',
      steps,
    })

    identity.recordResumeDialogViewed()
    identity.recordResumeRestarted()

    expect(capture.mock.calls.at(-1)).toEqual([
      'onboarding_resume_restarted',
      'https://supabase.capgo.test',
      {
        flow: 'pre_org',
        onboarding_attempt_id: ATTEMPT_A2,
        onboarding_run_id: RUN_R2,
        onboarding_version: ONBOARDING_ANALYTICS_VERSION,
        resume_onboarding_attempt_id: ATTEMPT_A1,
        resumed_from_run_id: RUN_R1,
        saved_step: 'organization',
        step_index: 2,
        total_steps: 4,
      },
    ])
    expect(identity.getProgressMetadata()).toEqual({
      lastRunId: RUN_R2,
      onboardingAttemptId: ATTEMPT_A2,
    })
  })

  it.concurrent('keeps resume identity metadata valid when lifecycle capture throws', () => {
    const capturedEvents: string[] = []
    const capture = vi.fn((name: string) => {
      capturedEvents.push(name)
      throw new Error('PostHog unavailable')
    })
    const createIdentity = () => {
      const ids = [ATTEMPT_A2, RUN_R2_UUID]
      const identity = createOnboardingTelemetryIdentity({
        capture,
        flow: 'pre_org',
        idFactory: () => ids.shift()!,
        supaHost: 'https://supabase.capgo.test',
      })
      identity.prepareResumeCandidate({
        lastRunId: RUN_R1,
        onboardingAttemptId: ATTEMPT_A1,
        savedStep: 'organization',
        steps,
      })
      return identity
    }
    const continuedIdentity = createIdentity()
    const restartedIdentity = createIdentity()

    expect(() => continuedIdentity.recordResumeDialogViewed()).not.toThrow()
    expect(() => continuedIdentity.recordResumeContinued()).not.toThrow()
    expect(() => restartedIdentity.recordResumeDialogViewed()).not.toThrow()
    expect(() => restartedIdentity.recordResumeRestarted()).not.toThrow()

    expect(capturedEvents).toEqual([
      'onboarding_resume_dialog_viewed',
      'onboarding_resume_continued',
      'onboarding_resume_dialog_viewed',
      'onboarding_resume_restarted',
    ])
    expect(continuedIdentity.getProgressMetadata()).toEqual({
      lastRunId: RUN_R2,
      onboardingAttemptId: ATTEMPT_A1,
    })
    expect(restartedIdentity.getProgressMetadata()).toEqual({
      lastRunId: RUN_R2,
      onboardingAttemptId: ATTEMPT_A2,
    })
  })

  it.concurrent('reports the initial real step with the stable version and approved properties', () => {
    const capture = vi.fn()
    const tracker = createOnboardingProgressTracker({
      ...trackerIdentity,
      capture,
      flow: 'pre_org',
      now: () => 100,
      resumed: false,
      steps,
      supaHost: 'https://supabase.capgo.test',
    })

    tracker.viewStep('intent')

    expect(ONBOARDING_ANALYTICS_VERSION).toBe(4)
    expect(capture).toHaveBeenCalledOnce()
    expect(capture).toHaveBeenCalledWith(
      'onboarding_step_viewed',
      'https://supabase.capgo.test',
      {
        flow: 'pre_org',
        onboarding_attempt_id: ATTEMPT_A1,
        onboarding_run_id: RUN_R1,
        onboarding_version: ONBOARDING_ANALYTICS_VERSION,
        resumed: false,
        step: 'intent',
        step_index: 0,
        total_steps: 4,
      },
    )
  })

  it.concurrent('tracks a hidden tab and its matching return before setup', () => {
    let now = 1_000
    const capture = vi.fn()
    const tracker = createOnboardingProgressTracker({
      ...trackerIdentity,
      capture,
      flow: 'pre_org',
      now: () => now,
      resumed: false,
      steps: ['intent', 'details', 'setup'],
      supaHost: 'https://supabase.capgo.test',
    })

    tracker.viewStep('intent')
    capture.mockClear()
    tracker.trackVisibilityChange('visible')
    now = 1_250
    tracker.trackVisibilityChange('hidden')
    tracker.trackVisibilityChange('hidden')
    now = 2_725.9
    tracker.trackVisibilityChange('visible')
    tracker.trackVisibilityChange('visible')

    expect(capture.mock.calls).toEqual([
      [
        'onboarding_visibility_changed',
        'https://supabase.capgo.test',
        expect.objectContaining({
          onboarding_attempt_id: ATTEMPT_A1,
          onboarding_run_id: RUN_R1,
          onboarding_version: ONBOARDING_ANALYTICS_VERSION,
          step: 'intent',
          step_index: 0,
          total_steps: 3,
          visibility_state: 'hidden',
        }),
      ],
      [
        'onboarding_visibility_changed',
        'https://supabase.capgo.test',
        expect.objectContaining({
          hidden_duration_ms: 1_475,
          onboarding_attempt_id: ATTEMPT_A1,
          onboarding_run_id: RUN_R1,
          onboarding_version: ONBOARDING_ANALYTICS_VERSION,
          step: 'intent',
          step_index: 0,
          total_steps: 3,
          visibility_state: 'visible',
        }),
      ],
    ])
  })

  it.concurrent('uses buffered visibility timestamps captured before tracker initialization', () => {
    const capture = vi.fn()
    const tracker = createOnboardingProgressTracker({
      ...trackerIdentity,
      capture,
      flow: 'pre_org',
      now: () => 5_000,
      resumed: false,
      steps: ['intent', 'setup'],
      supaHost: 'https://supabase.capgo.test',
    })

    tracker.viewStep('intent')
    capture.mockClear()
    tracker.trackVisibilityChange('hidden', 1_250)
    tracker.trackVisibilityChange('visible', 2_725.9)

    expect(capture.mock.calls).toEqual([
      [
        'onboarding_visibility_changed',
        'https://supabase.capgo.test',
        expect.objectContaining({
          step: 'intent',
          visibility_state: 'hidden',
        }),
      ],
      [
        'onboarding_visibility_changed',
        'https://supabase.capgo.test',
        expect.objectContaining({
          hidden_duration_ms: 1_475,
          step: 'intent',
          visibility_state: 'visible',
        }),
      ],
    ])
  })

  it.concurrent('drops an in-flight visibility pair when the active step changes', () => {
    let now = 100
    const capture = vi.fn()
    const tracker = createOnboardingProgressTracker({
      ...trackerIdentity,
      capture,
      flow: 'pre_org',
      now: () => now,
      resumed: false,
      steps: ['intent', 'details', 'setup'],
      supaHost: 'https://supabase.capgo.test',
    })

    tracker.viewStep('intent')
    capture.mockClear()
    now = 200
    tracker.trackVisibilityChange('hidden')
    tracker.viewStep('details', 'intent')
    capture.mockClear()
    now = 500
    tracker.trackVisibilityChange('visible')

    expect(capture).not.toHaveBeenCalled()
  })

  it.concurrent('stops visibility tracking when setup is reached', () => {
    let now = 100
    const capture = vi.fn()
    const tracker = createOnboardingProgressTracker({
      ...trackerIdentity,
      capture,
      flow: 'pre_org',
      now: () => now,
      resumed: false,
      steps: ['intent', 'setup'],
      supaHost: 'https://supabase.capgo.test',
    })

    tracker.trackVisibilityChange('hidden')
    tracker.trackVisibilityChange('visible')
    tracker.viewStep('intent')
    capture.mockClear()
    now = 200
    tracker.trackVisibilityChange('hidden')
    tracker.viewStep('setup', 'intent')
    capture.mockClear()
    now = 500
    tracker.trackVisibilityChange('visible')
    tracker.trackVisibilityChange('hidden')

    expect(capture).not.toHaveBeenCalled()
  })

  it.concurrent('uses the supplied identity for every event from a tracker instance', () => {
    const capture = vi.fn()
    const tracker = createOnboardingProgressTracker({
      ...trackerIdentity,
      capture,
      flow: 'pre_org',
      resumed: false,
      steps,
      supaHost: 'https://supabase.capgo.test',
    })

    tracker.viewStep('intent')
    tracker.completeStep('intent', { nextStep: 'details' })

    expect(capture.mock.calls.map(call => call[2])).toEqual([
      expect.objectContaining({ onboarding_attempt_id: ATTEMPT_A1, onboarding_run_id: RUN_R1 }),
      expect.objectContaining({ onboarding_attempt_id: ATTEMPT_A1, onboarding_run_id: RUN_R1 }),
    ])
  })

  it.concurrent('reports completion before the next view with duration and narrow context', () => {
    let now = 1_000
    const capture = vi.fn()
    const tracker = createOnboardingProgressTracker({
      ...trackerIdentity,
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
      onboarding_attempt_id: ATTEMPT_A1,
      onboarding_run_id: RUN_R1,
      onboarding_version: ONBOARDING_ANALYTICS_VERSION,
      resumed: false,
      step: 'intent',
      step_index: 0,
      total_steps: 4,
    })
    expect(capture.mock.calls[2]?.[2]).toEqual({
      flow: 'pre_org',
      onboarding_attempt_id: ATTEMPT_A1,
      onboarding_run_id: RUN_R1,
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
      ...trackerIdentity,
      capture,
      flow: 'pre_org',
      resumed: false,
      steps,
      supaHost: 'https://supabase.capgo.test',
    })

    tracker.trackDetailsEvent('onboarding_app_name_entered', 'details', { field_length: 11 })

    expect(capture).toHaveBeenCalledWith(
      'onboarding_app_name_entered',
      'https://supabase.capgo.test',
      expect.objectContaining({
        field_length: 11,
        flow: 'pre_org',
        onboarding_attempt_id: ATTEMPT_A1,
        onboarding_run_id: RUN_R1,
        onboarding_version: ONBOARDING_ANALYTICS_VERSION,
        step: 'details',
      }),
    )
  })

  it.concurrent('associates app-details interactions with their page-level analytics step', () => {
    const capture = vi.fn()
    const pageSteps = ['intent', 'app_name', 'app_id', 'app_icon', 'organization', 'setup'] as const
    const tracker = createOnboardingProgressTracker({
      ...trackerIdentity,
      capture,
      flow: 'pre_org',
      resumed: false,
      steps: pageSteps,
      supaHost: 'https://supabase.capgo.test',
    })

    tracker.viewStep('app_name')
    capture.mockClear()
    tracker.trackDetailsEvent('onboarding_app_name_entered', 'app_name', { field_length: 11 })

    expect(capture).toHaveBeenCalledWith(
      'onboarding_app_name_entered',
      'https://supabase.capgo.test',
      expect.objectContaining({
        field_length: 11,
        step: 'app_name',
        step_index: 1,
        total_steps: 6,
      }),
    )
  })

  it.concurrent('associates app creation outcomes with sanitized choice metadata', () => {
    const capture = vi.fn()
    const tracker = createOnboardingProgressTracker({
      ...trackerIdentity,
      capture,
      flow: 'pre_org',
      resumed: false,
      steps,
      supaHost: 'https://supabase.capgo.test',
    })

    tracker.trackDetailsEvent('onboarding_app_creation_succeeded', 'details', {
      app_id_source: 'generated',
      has_icon: true,
      icon_source: 'store',
      used_fallback: false,
    })

    expect(capture).toHaveBeenCalledWith(
      'onboarding_app_creation_succeeded',
      'https://supabase.capgo.test',
      expect.objectContaining({
        app_id_source: 'generated',
        has_icon: true,
        icon_source: 'store',
        used_fallback: false,
      }),
    )
  })

  it.concurrent('associates organization interactions with the active attempt', () => {
    const capture = vi.fn()
    const tracker = createOnboardingProgressTracker({
      ...trackerIdentity,
      capture,
      flow: 'pre_org',
      resumed: false,
      steps,
      supaHost: 'https://supabase.capgo.test',
    })

    tracker.trackStepEvent('onboarding_organization_import_opened', 'organization')

    expect(capture).toHaveBeenCalledWith(
      'onboarding_organization_import_opened',
      'https://supabase.capgo.test',
      expect.objectContaining({
        flow: 'pre_org',
        onboarding_attempt_id: ATTEMPT_A1,
        onboarding_run_id: RUN_R1,
        onboarding_version: ONBOARDING_ANALYTICS_VERSION,
        step: 'organization',
      }),
    )
  })

  it.concurrent('captures copy events with the active onboarding attempt context', () => {
    const capture = vi.fn()
    const tracker = createOnboardingProgressTracker({
      ...trackerIdentity,
      capture,
      flow: 'pre_org',
      resumed: true,
      steps,
      supaHost: 'https://supabase.capgo.test',
    })
    tracker.viewStep('setup')
    capture.mockClear()

    const properties = tracker.trackCopyEvent('onboarding_ai_instructions_copied', {
      app_id: 'com.example.app',
      existing_app: true,
      intent: 'ota',
      org_id: 'org-id',
      setup_command: 'ota',
    })

    expect(capture).toHaveBeenCalledWith(
      'onboarding_ai_instructions_copied',
      'https://supabase.capgo.test',
      expect.objectContaining({
        app_id: 'com.example.app',
        existing_app: true,
        flow: 'pre_org',
        intent: 'ota',
        onboarding_attempt_id: ATTEMPT_A1,
        onboarding_run_id: RUN_R1,
        onboarding_version: ONBOARDING_ANALYTICS_VERSION,
        org_id: 'org-id',
        resumed: true,
        setup_command: 'ota',
        step: 'setup',
      }),
    )
    expect(properties).toEqual(capture.mock.calls[0]?.[2])
  })

  it.concurrent('captures dashboard exploration with the active onboarding attempt context', () => {
    const capture = vi.fn()
    const tracker = createOnboardingProgressTracker({
      ...trackerIdentity,
      capture,
      flow: 'pre_org',
      resumed: true,
      steps,
      supaHost: 'https://supabase.capgo.test',
    })
    tracker.viewStep('setup')
    capture.mockClear()

    tracker.trackDashboardExplored('com.example.app')

    expect(capture).toHaveBeenCalledWith(
      'onboarding_dashboard_explored',
      'https://supabase.capgo.test',
      expect.objectContaining({
        app_id: 'com.example.app',
        onboarding_attempt_id: ATTEMPT_A1,
        onboarding_run_id: RUN_R1,
        onboarding_version: ONBOARDING_ANALYTICS_VERSION,
        resumed: true,
        step: 'setup',
      }),
    )
  })

  it.concurrent('deduplicates completion for one visit and resets timing after back navigation', () => {
    let now = 10
    const capture = vi.fn()
    const tracker = createOnboardingProgressTracker({
      ...trackerIdentity,
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
      ...trackerIdentity,
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
      ...trackerIdentity,
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
      ...trackerIdentity,
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
      'onboarding_run_id',
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
