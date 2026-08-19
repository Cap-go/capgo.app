import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOnboardingProgressTracker } from '../src/utils/onboardingProgressAnalytics'

const {
  getPostHogBrowserContextMock,
  pushEventMock,
  sendEventMock,
} = vi.hoisted(() => ({
  getPostHogBrowserContextMock: vi.fn(() => ({
    $current_url: 'https://web.capgo.app/onboarding',
    $device_id: 'device-id',
    $pathname: '/onboarding',
    $referrer: 'https://capgo.app/',
    $session_id: 'session-id',
    $window_id: 'window-id',
  })),
  pushEventMock: vi.fn(),
  sendEventMock: vi.fn(async (_payload: unknown) => null),
}))

vi.mock('~/services/posthog', () => ({
  getPostHogBrowserContext: getPostHogBrowserContextMock,
  pushEvent: pushEventMock,
}))

vi.mock('~/services/tracking', () => ({
  sendEvent: sendEventMock,
}))

const trackerIdentity = {
  onboardingAttemptId: '7e64f484-4171-47b6-86f7-0ef5d49e0ef8',
  onboardingRunId: 'ir_6b735b41-f8ea-45b9-a46e-10c8be795276',
}

function createTracker() {
  return createOnboardingProgressTracker({
    ...trackerIdentity,
    flow: 'pre_org',
    resumed: false,
    steps: ['intent', 'setup'],
    supaHost: 'https://supabase.capgo.test',
  })
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(1_755_600_000_000)
})

afterEach(() => {
  vi.restoreAllMocks()
  pushEventMock.mockClear()
  sendEventMock.mockClear()
  getPostHogBrowserContextMock.mockClear()
})

describe('onboarding backend tracking', () => {
  it('routes default onboarding analytics through the authenticated backend with browser context', () => {
    const tracker = createTracker()

    tracker.viewStep('intent')

    expect(pushEventMock).not.toHaveBeenCalled()
    expect(sendEventMock).toHaveBeenCalledOnce()
    expect(sendEventMock).toHaveBeenCalledWith({
      channel: 'onboarding',
      event: 'onboarding_step_viewed',
      nonPersonTags: {
        $current_url: 'https://web.capgo.app/onboarding',
        $device_id: 'device-id',
        $pathname: '/onboarding',
        $referrer: 'https://capgo.app/',
        $session_id: 'session-id',
        $window_id: 'window-id',
        flow: 'pre_org',
        onboarding_attempt_id: trackerIdentity.onboardingAttemptId,
        onboarding_run_id: trackerIdentity.onboardingRunId,
        onboarding_version: 4,
        resumed: false,
        step: 'intent',
        step_index: 0,
        total_steps: 2,
      },
      timestamp: 1_755_600_000_000,
      tracking_version: 2,
    })
    expect(sendEventMock.mock.calls[0]?.[0]).not.toHaveProperty('user_id')
  })

  it('sends the AI-copy event once with the verified org and app context needed by Bento', () => {
    const tracker = createTracker()
    tracker.viewStep('setup')
    sendEventMock.mockClear()

    tracker.trackCopyEvent('onboarding_ai_instructions_copied', {
      app_id: 'com.example.app',
      existing_app: true,
      intent: 'ota',
      org_id: 'org-id',
      setup_command: 'ota',
    })

    expect(sendEventMock).toHaveBeenCalledOnce()
    expect(sendEventMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'onboarding',
      event: 'onboarding_ai_instructions_copied',
      nonPersonTags: expect.objectContaining({
        $session_id: 'session-id',
        app_id: 'com.example.app',
        org_id: 'org-id',
      }),
      org_id: 'org-id',
      tags: { app_id: 'com.example.app' },
      timestamp: 1_755_600_000_000,
      tracking_version: 2,
    }))
  })
})
