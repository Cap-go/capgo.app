import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendEventToTrackingMock = vi.hoisted(() => vi.fn())
const sendDiscordAlertMock = vi.hoisted(() => vi.fn())
const maybeSingleMock = vi.hoisted(() => vi.fn())
const backgroundTaskMock = vi.hoisted(() => vi.fn())

vi.mock('../supabase/functions/_backend/utils/tracking.ts', () => ({
  sendEventToTracking: sendEventToTrackingMock,
}))

vi.mock('../supabase/functions/_backend/utils/discord.ts', () => ({
  sendDiscordAlert: sendDiscordAlertMock,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: maybeSingleMock }),
      }),
    }),
  }),
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  backgroundTask: backgroundTaskMock,
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

function emitBuildTransition(input: Omit<Parameters<typeof emitBuildTransitionEvent>[1], 'build'>) {
  return emitBuildTransitionEvent(fakeContext(), { ...input, build: baseBuild })
}

describe('emitBuildTransitionEvent', () => {
  beforeEach(() => {
    sendEventToTrackingMock.mockReset()
    sendEventToTrackingMock.mockResolvedValue(undefined)
    sendDiscordAlertMock.mockReset()
    sendDiscordAlertMock.mockResolvedValue(true)
    maybeSingleMock.mockReset()
    maybeSingleMock.mockResolvedValue({ data: { email: 'developer@example.test' }, error: null })
    backgroundTaskMock.mockReset()
    backgroundTaskMock.mockResolvedValue(null)
  })

  it('emits Build Started with no duration_seconds and no failure_category', async () => {
    await emitBuildTransition({
      previousStatus: 'pending',
      effectiveStatus: 'running',
      timeoutApplied: false,
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
    await emitBuildTransition({
      previousStatus: 'running',
      effectiveStatus: 'succeeded',
      timeoutApplied: false,
      effectiveBuildTimeSeconds: 123,
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
    await emitBuildTransition({
      previousStatus: 'running',
      effectiveStatus: 'failed',
      timeoutApplied: false,
      effectiveError: 'gradle compile failed',
      effectiveBuildTimeSeconds: 42,
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
    await emitBuildTransition({
      previousStatus: 'running',
      effectiveStatus: 'failed',
      timeoutApplied: false,
      effectiveError: 'missing credentials',
    })

    const [, payload] = sendEventToTrackingMock.mock.calls[0]
    expect(payload.tags.failure_category).toBe('validation_error')
  })

  it('emits Build Timed Out with failure_category=timeout and capped duration', async () => {
    await emitBuildTransition({
      previousStatus: 'running',
      effectiveStatus: 'failed',
      timeoutApplied: true,
      effectiveError: 'Build timed out after N seconds',
      effectiveBuildTimeSeconds: 1800,
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
    await emitBuildTransition({
      previousStatus: 'succeeded',
      effectiveStatus: 'succeeded',
      timeoutApplied: false,
    })

    expect(sendEventToTrackingMock).not.toHaveBeenCalled()
  })

  it('does NOT call sendEventToTracking when previous === next and no timeout applied', async () => {
    await emitBuildTransition({
      previousStatus: 'running',
      effectiveStatus: 'running',
      timeoutApplied: false,
    })

    expect(sendEventToTrackingMock).not.toHaveBeenCalled()
  })

  it('does NOT include duration_seconds for the started transition even when effectiveBuildTimeSeconds is set', async () => {
    await emitBuildTransition({
      previousStatus: 'pending',
      effectiveStatus: 'running',
      timeoutApplied: false,
      effectiveBuildTimeSeconds: 7,
    })

    const [, payload] = sendEventToTrackingMock.mock.calls[0]
    expect(payload.tags.duration_seconds).toBeUndefined()
  })

  it('does NOT include duration_seconds when value is null', async () => {
    await emitBuildTransition({
      previousStatus: 'running',
      effectiveStatus: 'succeeded',
      timeoutApplied: false,
      effectiveBuildTimeSeconds: null,
    })

    const [, payload] = sendEventToTrackingMock.mock.calls[0]
    expect(payload.tags.duration_seconds).toBeUndefined()
  })

  it('alerts Discord below the 10-second boundary and includes identifying fields', async () => {
    let resolveEmailLookup!: (value: unknown) => void
    maybeSingleMock.mockReturnValue(new Promise(resolve => resolveEmailLookup = resolve))

    await emitBuildTransition({
      jobId: 'job-uuid-1',
      previousStatus: 'running',
      effectiveStatus: 'failed',
      timeoutApplied: false,
      effectiveBuildTimeSeconds: 9,
    })

    expect(backgroundTaskMock).toHaveBeenCalledTimes(1)
    expect(sendDiscordAlertMock).not.toHaveBeenCalled()
    resolveEmailLookup({ data: { email: 'developer@example.test' }, error: null })
    await backgroundTaskMock.mock.calls[0][1]

    expect(sendDiscordAlertMock).toHaveBeenCalledTimes(1)
    const payload = sendDiscordAlertMock.mock.calls[0][1]
    const fields = Object.fromEntries(payload.embeds[0].fields.map((field: any) => [field.name, field.value]))
    expect(payload.allowed_mentions).toEqual({ parse: [] })
    expect(fields).toEqual({
      'Job ID': 'job-uuid-1',
      'Platform': 'ios',
      'App ID': 'com.example.app',
      'Email': 'developer@example.test',
      'Runtime': '9s',
    })

    sendDiscordAlertMock.mockClear()
    backgroundTaskMock.mockClear()
    await emitBuildTransition({
      jobId: 'job-uuid-2',
      previousStatus: 'running',
      effectiveStatus: 'failed',
      timeoutApplied: false,
      effectiveBuildTimeSeconds: 10,
    })

    expect(sendDiscordAlertMock).not.toHaveBeenCalled()
    expect(backgroundTaskMock).not.toHaveBeenCalled()
  })
})
