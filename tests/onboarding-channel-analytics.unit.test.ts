import { describe, expect, it, vi } from 'vitest'
import type { OnboardingChannelEvent, OnboardingChannelEventProperties } from '../src/utils/onboardingChannelAnalytics'
import { createOnboardingChannelAnimationTracker, withOnboardingChannelOrigin } from '../src/utils/onboardingChannelAnalytics'
import { createOnboardingProgressTracker, NEW_CHANNEL_ANALYTICS_VERSION } from '../src/utils/onboardingProgressAnalytics'

function createTracker() {
  let now = 1_000
  let progress = 0
  const events: Array<{ event: OnboardingChannelEvent, properties: OnboardingChannelEventProperties }> = []
  const emit = vi.fn((event: OnboardingChannelEvent, properties: OnboardingChannelEventProperties) => {
    events.push({ event, properties })
  })
  const tracker = createOnboardingChannelAnimationTracker({
    emit,
    now: () => now,
    stage: 'channel-routing',
  })
  const source = {
    durationMs: () => 8_000,
    progress: () => progress,
  }

  return {
    advance(milliseconds: number) {
      now += milliseconds
    },
    emit,
    events,
    setProgress(value: number) {
      progress = value
    },
    source,
    tracker,
  }
}

describe('onboarding channel animation analytics', () => {
  it.concurrent('keeps todo-list and regular-onboarding origins distinct through the PostHog capture pipeline', () => {
    const capture = vi.fn()
    const progress = createOnboardingProgressTracker({
      capture,
      flow: 'pre_org',
      steps: ['setup'],
      resumed: true,
      onboardingAttemptId: '00000000-0000-4000-8000-000000000001',
      onboardingRunId: 'ir_00000000-0000-4000-8000-000000000002',
      onboardingVersion: () => NEW_CHANNEL_ANALYTICS_VERSION,
      supaHost: 'https://supabase.capgo.test',
    })
    progress.viewStep('setup')
    const regular = createOnboardingChannelAnimationTracker({
      stage: 'channel-routing',
      emit: (event, properties) => progress.trackStepEvent(event, 'setup', withOnboardingChannelOrigin(properties)),
    })
    regular.start('automatic', { durationMs: () => 8000, progress: () => 0.25 })
    const todo = createOnboardingChannelAnimationTracker({
      stage: 'channel-routing',
      emit: (event, properties) => progress.trackStepEvent(event, 'setup', withOnboardingChannelOrigin(withOnboardingChannelOrigin(properties, 'todo_list'))),
    })
    todo.start('automatic', { durationMs: () => 8000, progress: () => 0.25 })
    todo.replayRequested()
    todo.start('replay', { durationMs: () => 8000, progress: () => 0.25 })
    todo.dispose()
    progress.trackStepEvent('onboarding_channel_create_succeeded', 'setup', withOnboardingChannelOrigin({
      channel_stage: 'channel-create',
      created_in_onboarding: true,
      channel_name_length: 10,
    }, 'todo_list'))

    const channelCaptures = capture.mock.calls.filter(call => call[0].startsWith('onboarding_channel_'))
    expect(channelCaptures.filter(call => call[2].channel_flow_origin === 'onboarding').map(call => call[0])).toEqual([
      'onboarding_channel_stage_viewed',
      'onboarding_channel_animation_started',
    ])
    expect(channelCaptures.filter(call => call[2].channel_flow_origin === 'todo_list').map(call => call[0])).toEqual([
      'onboarding_channel_stage_viewed',
      'onboarding_channel_animation_started',
      'onboarding_channel_animation_replayed',
      'onboarding_channel_animation_started',
      'onboarding_channel_animation_interrupted',
      'onboarding_channel_create_succeeded',
    ])
    for (const [, , properties] of channelCaptures) {
      expect(properties).toMatchObject({ onboarding_version: NEW_CHANNEL_ANALYTICS_VERSION, resumed: true, step: 'setup' })
      expect(properties).not.toHaveProperty('channel_name')
    }
  })

  it.concurrent('tracks the stage, animation start, completion, and a completed continuation', () => {
    const context = createTracker()
    context.tracker.start('automatic', context.source)
    context.advance(8_100)
    context.setProgress(1)
    context.tracker.complete()
    context.tracker.complete()
    context.tracker.leave('continue')

    expect(context.events.map(({ event }) => event)).toEqual([
      'onboarding_channel_stage_viewed',
      'onboarding_channel_animation_started',
      'onboarding_channel_animation_completed',
    ])
    expect(context.events[2]?.properties).toMatchObject({
      animation_duration_ms: 8_000,
      animation_elapsed_ms: 8_000,
      animation_progress_percent: 100,
      animation_run_index: 1,
      channel_stage: 'channel-routing',
      had_completed_animation: true,
      replay_count: 0,
      watch_duration_ms: 8_100,
    })
  })

  it.concurrent('records a continue before completion as an animation skip', () => {
    const context = createTracker()
    context.tracker.start('automatic', context.source)
    context.advance(2_500)
    context.setProgress(0.3125)
    context.tracker.leave('continue')
    context.tracker.dispose()

    expect(context.events.map(({ event }) => event)).toEqual([
      'onboarding_channel_stage_viewed',
      'onboarding_channel_animation_started',
      'onboarding_channel_animation_skipped',
    ])
    expect(context.events[2]?.properties).toMatchObject({
      animation_elapsed_ms: 2_500,
      animation_progress_percent: 31,
      exit_action: 'continue',
      had_completed_animation: false,
      watch_duration_ms: 2_500,
    })
  })

  it.concurrent('captures replay context and numbers the replacement run', () => {
    const context = createTracker()
    context.tracker.start('automatic', context.source)
    context.advance(1_600)
    context.setProgress(0.2)
    context.tracker.replayRequested()
    context.setProgress(0)
    context.tracker.start('replay', context.source)

    expect(context.events.map(({ event }) => event)).toEqual([
      'onboarding_channel_stage_viewed',
      'onboarding_channel_animation_started',
      'onboarding_channel_animation_replayed',
      'onboarding_channel_animation_started',
    ])
    expect(context.events[2]?.properties).toMatchObject({
      animation_progress_percent: 20,
      animation_run_index: 1,
      replay_count: 1,
    })
    expect(context.events[3]?.properties).toMatchObject({
      animation_run_index: 2,
      animation_trigger: 'replay',
      replay_count: 1,
    })
  })

  it.concurrent('freezes completed watch duration before a later replay', () => {
    const context = createTracker()
    context.tracker.start('automatic', context.source)
    context.advance(8_100)
    context.setProgress(1)
    context.tracker.complete()
    context.advance(4_000)
    context.tracker.replayRequested()

    expect(context.events.at(-1)).toMatchObject({
      event: 'onboarding_channel_animation_replayed',
      properties: {
        had_completed_animation: true,
        replay_count: 1,
        watch_duration_ms: 8_100,
      },
    })
  })

  it.concurrent('distinguishes back navigation from an unexpected unmount', () => {
    const backed = createTracker()
    backed.tracker.start('automatic', backed.source)
    backed.tracker.leave('back')
    backed.tracker.dispose()

    expect(backed.events.map(({ event }) => event)).toEqual([
      'onboarding_channel_stage_viewed',
      'onboarding_channel_animation_started',
      'onboarding_channel_animation_interrupted',
    ])
    expect(backed.events[2]?.properties.exit_action).toBe('back')

    const unmounted = createTracker()
    unmounted.tracker.start('automatic', unmounted.source)
    unmounted.tracker.dispose()
    expect(unmounted.events.at(-1)).toMatchObject({
      event: 'onboarding_channel_animation_interrupted',
      properties: { exit_action: 'unmounted' },
    })
  })

  it.concurrent('reports reduced motion without treating continuation as a skip', () => {
    const context = createTracker()
    context.tracker.showReducedMotion()
    context.tracker.leave('continue')

    expect(context.events.map(({ event }) => event)).toEqual([
      'onboarding_channel_stage_viewed',
      'onboarding_channel_reduced_motion_shown',
    ])
    expect(context.events[1]?.properties).toMatchObject({
      channel_stage: 'channel-routing',
      had_completed_animation: true,
      reduced_motion: true,
    })
  })

  it.concurrent('reports a timeline that cannot be built', () => {
    const context = createTracker()
    context.tracker.unavailable()

    expect(context.events).toEqual([
      {
        event: 'onboarding_channel_stage_viewed',
        properties: { channel_stage: 'channel-routing', reduced_motion: false },
      },
      {
        event: 'onboarding_channel_animation_unavailable',
        properties: {
          channel_stage: 'channel-routing',
          failure_reason: 'timeline_unavailable',
          reduced_motion: false,
        },
      },
    ])
  })
})
