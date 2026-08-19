import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendOnboardingEvent } from '../src/services/onboardingTracking'
import { createOnboardingProgressTracker } from '../src/utils/onboardingProgressAnalytics'

const {
  getLocalConfigMock,
  sendEventMock,
} = vi.hoisted(() => ({
  getLocalConfigMock: vi.fn(() => ({ supaHost: 'https://sb.capgo.app' })),
  sendEventMock: vi.fn(async (_payload: unknown) => null),
}))

vi.mock('~/services/supabase', () => ({
  getLocalConfig: getLocalConfigMock,
  isLocal: (supaHost: string) => supaHost !== 'https://sb.capgo.app',
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
  getLocalConfigMock.mockReturnValue({ supaHost: 'https://sb.capgo.app' })
  vi.stubGlobal('posthog', {
    get_property: (property: string) => property === '$window_id' ? 'window-id' : 'device-id',
    get_session_id: () => 'session-id',
  })
  vi.stubGlobal('window', {
    location: {
      href: 'https://web.capgo.app/onboarding?access_token=secret#refresh_token=secret',
      origin: 'https://web.capgo.app',
      pathname: '/onboarding',
    },
  })
  vi.stubGlobal('document', { referrer: 'https://capgo.app/' })
  vi.spyOn(Date, 'now').mockReturnValue(1_755_600_000_000)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  getLocalConfigMock.mockClear()
  sendEventMock.mockClear()
})

describe('onboarding backend tracking', () => {
  it('routes default onboarding analytics through the authenticated backend with browser context', () => {
    const tracker = createTracker()

    tracker.viewStep('intent')

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

  it('does not dispatch onboarding analytics outside the production Supabase host', () => {
    getLocalConfigMock.mockReturnValue({ supaHost: 'http://127.0.0.1:54321' })
    const tracker = createTracker()

    tracker.viewStep('intent')

    expect(sendEventMock).not.toHaveBeenCalled()
  })

  it('owns the fire-and-forget promise so component callers cannot create unhandled rejections', () => {
    expect(sendOnboardingEvent('onboarding_step_viewed')).toBeUndefined()
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

  it('keeps demo action metadata in the backend-routed compatibility event', () => {
    const source = readFileSync(new URL('../src/components/dashboard/DemoOnboardingModal.vue', import.meta.url), 'utf8')

    expect(source).toContain('sendOnboardingEvent(`user:${event}`, { org_id: orgId, ...tags })')
  })
})
