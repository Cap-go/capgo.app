import { beforeEach, describe, expect, it, vi } from 'vitest'
import { trackBuilderOnboardingStep } from '../cli/src/build/onboarding/telemetry.ts'

const sendEventMock = vi.hoisted(() => vi.fn())

vi.mock('../cli/src/utils.ts', () => ({
  defaultApiHost: 'https://api.capgo.app',
  getRemoteConfig: vi.fn().mockResolvedValue({ hostApi: 'https://api.capgo.app' }),
  sendEvent: sendEventMock,
}))

const base = { apikey: 'cap_test_key', platform: 'ios', appId: 'com.example.app', orgId: 'org-uuid-1' } as const

describe('trackBuilderOnboardingStep', () => {
  beforeEach(() => {
    sendEventMock.mockReset()
    sendEventMock.mockResolvedValue(undefined)
  })

  it('builds the expected payload and calls sendEvent once', async () => {
    await trackBuilderOnboardingStep({
      ...base,
      step: 'api-key-instructions',
      durationMs: 1234,
      durationStep: 'welcome',
    })

    expect(sendEventMock).toHaveBeenCalledTimes(1)
    const [calledKey, payload] = sendEventMock.mock.calls[0]
    expect(calledKey).toBe('cap_test_key')
    expect(payload).toMatchObject({
      event: 'Builder Onboarding Step',
      channel: 'builder-onboarding',
      org_id: 'org-uuid-1',
      tracking_version: 2,
      tags: {
        step: 'api-key-instructions',
        platform: 'ios',
        app_id: 'com.example.app',
        duration_ms: '1234',
        duration_step: 'welcome',
      },
    })
    expect(payload.tags.error_category).toBeUndefined()
  })

  it('includes error_category only when an error is provided', async () => {
    await trackBuilderOnboardingStep({
      ...base,
      step: 'error',
      error: Object.assign(new Error('Unauthorized'), { status: 401 }),
    })

    const [, payload] = sendEventMock.mock.calls[0]
    expect(payload.tags.error_category).toBe('apple_api_unauthorized')
  })

  it('uses the Android mapper when platform is android', async () => {
    await trackBuilderOnboardingStep({
      ...base,
      step: 'error',
      platform: 'android',
      error: Object.assign(new Error('Bad keystore'), { phase: 'keystore' }),
    })

    const [, payload] = sendEventMock.mock.calls[0]
    expect(payload.tags.error_category).toBe('keystore_invalid')
  })

  it('swallows errors thrown by sendEvent', async () => {
    sendEventMock.mockRejectedValueOnce(new Error('network down'))
    await expect(trackBuilderOnboardingStep({
      ...base,
      step: 'welcome',
    })).resolves.toBeUndefined()
  })

  it('does not include duration_ms when undefined', async () => {
    await trackBuilderOnboardingStep({
      ...base,
      step: 'welcome',
    })

    const [, payload] = sendEventMock.mock.calls[0]
    expect(payload.tags.duration_ms).toBeUndefined()
  })

  it('uses pre-computed errorCategory when provided (skipping the mapper)', async () => {
    await trackBuilderOnboardingStep({
      ...base,
      step: 'error',
      errorCategory: 'profile_creation_failed',
      // error intentionally omitted
    })

    const [, payload] = sendEventMock.mock.calls[0]
    expect(payload.tags.error_category).toBe('profile_creation_failed')
  })
})
