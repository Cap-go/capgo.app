import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendEventToTrackingMock = vi.hoisted(() => vi.fn())

vi.mock('../supabase/functions/_backend/utils/tracking.ts', () => ({
  sendEventToTracking: sendEventToTrackingMock,
}))

const { emitBuildTransitionEvent } = await import('../supabase/functions/_backend/utils/build_tracking.ts')

const baseBuild = {
  app_id: 'com.example.app',
  platform: 'ios',
  build_mode: 'release',
  owner_org: 'org-uuid-1',
  requested_by: 'user-uuid-1',
}

function fakeContext() {
  return {} as any
}

describe('emitBuildTransitionEvent', () => {
  beforeEach(() => {
    sendEventToTrackingMock.mockReset()
    sendEventToTrackingMock.mockResolvedValue(undefined)
  })

  it('emits Build Started with no duration_seconds and no failure_category', async () => {
    await emitBuildTransitionEvent(fakeContext(), {
      previousStatus: 'pending',
      effectiveStatus: 'running',
      timeoutApplied: false,
      build: baseBuild,
    })

    expect(sendEventToTrackingMock).toHaveBeenCalledTimes(1)
    const [, payload] = sendEventToTrackingMock.mock.calls[0]
    expect(payload).toMatchObject({
      event: 'Build Started',
      channel: 'build-lifecycle',
      user_id: 'user-uuid-1',
      groups: { organization: 'org-uuid-1' },
      tags: {
        app_id: 'com.example.app',
        org_id: 'org-uuid-1',
        platform: 'ios',
        build_mode: 'release',
      },
    })
    expect(payload.tags.duration_seconds).toBeUndefined()
    expect(payload.tags.failure_category).toBeUndefined()
  })

  it('emits Build Succeeded with duration_seconds when provided', async () => {
    await emitBuildTransitionEvent(fakeContext(), {
      previousStatus: 'running',
      effectiveStatus: 'succeeded',
      timeoutApplied: false,
      effectiveBuildTimeSeconds: 123,
      build: baseBuild,
    })

    const [, payload] = sendEventToTrackingMock.mock.calls[0]
    expect(payload).toMatchObject({
      event: 'Build Succeeded',
      tags: {
        duration_seconds: '123',
      },
    })
    expect(payload.tags.failure_category).toBeUndefined()
  })

  it('emits Build Failed with failure_category=builder_error for a generic error message', async () => {
    await emitBuildTransitionEvent(fakeContext(), {
      previousStatus: 'running',
      effectiveStatus: 'failed',
      timeoutApplied: false,
      effectiveError: 'gradle compile failed',
      effectiveBuildTimeSeconds: 42,
      build: baseBuild,
    })

    const [, payload] = sendEventToTrackingMock.mock.calls[0]
    expect(payload).toMatchObject({
      event: 'Build Failed',
      tags: {
        failure_category: 'builder_error',
        duration_seconds: '42',
      },
    })
  })

  it('emits Build Failed with failure_category=validation_error for validation-style messages', async () => {
    await emitBuildTransitionEvent(fakeContext(), {
      previousStatus: 'running',
      effectiveStatus: 'failed',
      timeoutApplied: false,
      effectiveError: 'missing credentials',
      build: baseBuild,
    })

    const [, payload] = sendEventToTrackingMock.mock.calls[0]
    expect(payload.tags.failure_category).toBe('validation_error')
  })

  it('emits Build Timed Out with failure_category=timeout and capped duration', async () => {
    await emitBuildTransitionEvent(fakeContext(), {
      previousStatus: 'running',
      effectiveStatus: 'failed',
      timeoutApplied: true,
      effectiveError: 'Build timed out after N seconds',
      effectiveBuildTimeSeconds: 1800,
      build: baseBuild,
    })

    const [, payload] = sendEventToTrackingMock.mock.calls[0]
    expect(payload).toMatchObject({
      event: 'Build Timed Out',
      tags: {
        failure_category: 'timeout',
        duration_seconds: '1800',
      },
    })
  })

  it('does NOT call sendEventToTracking when previous status is already terminal', async () => {
    await emitBuildTransitionEvent(fakeContext(), {
      previousStatus: 'succeeded',
      effectiveStatus: 'succeeded',
      timeoutApplied: false,
      build: baseBuild,
    })

    expect(sendEventToTrackingMock).not.toHaveBeenCalled()
  })

  it('does NOT call sendEventToTracking when previous === next and no timeout applied', async () => {
    await emitBuildTransitionEvent(fakeContext(), {
      previousStatus: 'running',
      effectiveStatus: 'running',
      timeoutApplied: false,
      build: baseBuild,
    })

    expect(sendEventToTrackingMock).not.toHaveBeenCalled()
  })

  it('does NOT include duration_seconds for the started transition even when effectiveBuildTimeSeconds is set', async () => {
    await emitBuildTransitionEvent(fakeContext(), {
      previousStatus: 'pending',
      effectiveStatus: 'running',
      timeoutApplied: false,
      effectiveBuildTimeSeconds: 7,
      build: baseBuild,
    })

    const [, payload] = sendEventToTrackingMock.mock.calls[0]
    expect(payload.tags.duration_seconds).toBeUndefined()
  })

  it('does NOT include duration_seconds when value is null', async () => {
    await emitBuildTransitionEvent(fakeContext(), {
      previousStatus: 'running',
      effectiveStatus: 'succeeded',
      timeoutApplied: false,
      effectiveBuildTimeSeconds: null,
      build: baseBuild,
    })

    const [, payload] = sendEventToTrackingMock.mock.calls[0]
    expect(payload.tags.duration_seconds).toBeUndefined()
  })
})
