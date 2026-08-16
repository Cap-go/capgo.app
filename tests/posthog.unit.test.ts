import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  cloudlogErrMock,
  cloudlogMock,
  envState,
  fetchMock,
} = vi.hoisted(() => ({
  cloudlogErrMock: vi.fn(),
  cloudlogMock: vi.fn(),
  envState: {
    posthogApiHost: 'https://eu.i.posthog.com',
  },
  fetchMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: cloudlogMock,
  cloudlogErr: cloudlogErrMock,
  serializeError: (error: unknown) => ({
    cause: error instanceof Error ? error.cause : undefined,
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : 'Error',
    stack: error instanceof Error ? error.stack ?? 'N/A' : 'N/A',
  }),
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  existInEnv: () => true,
  getEnv: (_c: unknown, key: string) => {
    if (key === 'POSTHOG_API_KEY')
      return 'posthog-key'
    if (key === 'POSTHOG_API_HOST')
      return envState.posthogApiHost
    if (key === 'ENV_NAME')
      return 'prod'
    return ''
  },
  trimTrailingSlashes: (value: string) => {
    let end = value.length
    while (end > 0 && value[end - 1] === '/')
      end -= 1
    return value.slice(0, end)
  },
}))

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'request-id' : undefined,
    req: {
      method: 'POST',
      url: 'https://example.com/functions/v1/app',
    },
  } as any
}

beforeEach(() => {
  envState.posthogApiHost = 'https://eu.i.posthog.com'
  fetchMock.mockResolvedValue({
    ok: true,
    text: vi.fn().mockResolvedValue(''),
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  cloudlogErrMock.mockReset()
  cloudlogMock.mockReset()
  fetchMock.mockReset()
})

describe('posthog helper', () => {
  it('keeps person property updates enabled for normal PostHog events', async () => {
    const { trackPosthogEvent } = await import('../supabase/functions/_backend/utils/posthog.ts')

    await trackPosthogEvent(createContext(), {
      event: 'Tracked Event',
      channel: 'usage',
      description: 'tracked',
      user_id: 'user-id',
      tags: { app_id: 'app-id' },
    })

    const request = fetchMock.mock.calls[0]
    const body = JSON.parse(request?.[1]?.body as string)

    expect(body.distinct_id).toBe('user-id')
    expect(body.properties.$set).toEqual({ app_id: 'app-id' })
  })

  it('sends non-person API key context only with the event', async () => {
    const { trackPosthogEvent } = await import('../supabase/functions/_backend/utils/posthog.ts')

    await trackPosthogEvent(createContext(), {
      event: 'Tracked Event',
      channel: 'usage',
      nonPersonTags: { apikey_id: 87015 },
      user_id: 'user-id',
      tags: { app_id: 'app-id' },
    })

    const request = fetchMock.mock.calls[0]
    const body = JSON.parse(request?.[1]?.body as string)

    expect(body.properties.apikey_id).toBe(87015)
    expect(body.properties.$set).not.toHaveProperty('apikey_id')
  })

  it('can send historical events without updating person properties', async () => {
    const { trackPosthogEvent } = await import('../supabase/functions/_backend/utils/posthog.ts')

    await trackPosthogEvent(createContext(), {
      event: 'Historical Event',
      channel: 'usage',
      description: 'tracked',
      setPersonProperties: false,
      tags: { source_record_id: '123' },
      timestamp: '2026-03-01T00:00:00.000Z',
      user_id: 'org-id',
    })

    const request = fetchMock.mock.calls[0]
    const body = JSON.parse(request?.[1]?.body as string)

    expect(body.timestamp).toBe('2026-03-01T00:00:00.000Z')
    expect(body.properties.source_record_id).toBe('123')
    expect(body.properties).not.toHaveProperty('$set')
  })

  it('normalizes endpoint-shaped hosts for group identification', async () => {
    const { groupIdentifyPosthog } = await import('../supabase/functions/_backend/utils/posthog.ts')
    envState.posthogApiHost = 'https://eu.i.posthog.com/s/'

    await groupIdentifyPosthog(createContext(), {
      groupKey: 'org-id',
      groupType: 'organization',
      properties: { name: 'Capgo' },
    })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://eu.i.posthog.com/capture/')
  })

  it('identifies the replay person before sending the initial snapshot', async () => {
    const { capturePosthogReplaySnapshot } = await import('../supabase/functions/_backend/utils/posthog.ts')

    await capturePosthogReplaySnapshot(createContext(), {
      currentUrl: 'capgo-cli://init',
      distinctId: 'user-id',
      events: [{ data: { height: 600, href: 'capgo-cli://init', width: 900 }, timestamp: 123, type: 4 }],
      lib: '@capgo/cli',
      libVersion: '8.9.0',
      sessionId: 'init-session',
      timestamp: '2026-06-16T00:00:00.000Z',
      userEmail: 'user@example.com',
      userId: 'user-id',
      windowId: 'window-id',
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const identifyRequest = fetchMock.mock.calls[0]
    const identifyBody = JSON.parse(identifyRequest?.[1]?.body as string)
    const snapshotRequest = fetchMock.mock.calls[1]
    const snapshotBody = JSON.parse(snapshotRequest?.[1]?.body as string)

    expect(identifyRequest?.[0]).toBe('https://eu.i.posthog.com/capture/')
    expect(identifyBody.event).toBe('$identify')
    expect(identifyBody.distinct_id).toBe('user-id')
    expect(identifyBody.properties.$insert_id).toBe('cli-replay-identify:init-session')
    expect(identifyBody.properties.$set).toEqual({ email: 'user@example.com' })
    expect(identifyBody.properties).not.toHaveProperty('email')
    expect(identifyRequest?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(snapshotRequest?.[0]).toBe('https://eu.i.posthog.com/s/')
    expect(snapshotBody.event).toBe('$snapshot')
    expect(snapshotBody.api_key).toBe('posthog-key')
    expect(snapshotBody.distinct_id).toBe('user-id')
    expect(snapshotBody.properties.token).toBe('posthog-key')
    expect(snapshotBody.properties.user_id).toBe('user-id')
    expect(snapshotBody.properties.$session_id).toBe('init-session')
    expect(snapshotBody.properties.$window_id).toBe('window-id')
    expect(snapshotBody.properties.$snapshot_data).toHaveLength(1)
    expect(snapshotRequest?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it.each([
    'https://eu.i.posthog.com',
    'https://eu.i.posthog.com/capture/',
    'https://eu.i.posthog.com/i/v0/e',
    'https://eu.i.posthog.com/s/',
  ])('normalizes %s before identifying and recording', async (host) => {
    const { capturePosthogReplaySnapshot } = await import('../supabase/functions/_backend/utils/posthog.ts')
    envState.posthogApiHost = host

    await capturePosthogReplaySnapshot(createContext(), {
      currentUrl: 'capgo-cli://init',
      distinctId: 'user-id',
      events: [{ type: 4 }],
      lib: '@capgo/cli',
      libVersion: '8.9.0',
      sessionId: 'init-session',
      timestamp: '2026-06-16T00:00:00.000Z',
      userEmail: 'user@example.com',
      userId: 'user-id',
      windowId: 'window-id',
    })

    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'https://eu.i.posthog.com/capture/',
      'https://eu.i.posthog.com/s/',
    ])
  })

  it('still records when the replay email is unavailable', async () => {
    const { capturePosthogReplaySnapshot } = await import('../supabase/functions/_backend/utils/posthog.ts')

    await capturePosthogReplaySnapshot(createContext(), {
      currentUrl: 'capgo-cli://init',
      distinctId: 'user-id',
      events: [{ type: 4 }],
      lib: '@capgo/cli',
      libVersion: '8.9.0',
      sessionId: 'init-session',
      timestamp: '2026-06-16T00:00:00.000Z',
      userId: 'user-id',
      windowId: 'window-id',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://eu.i.posthog.com/s/')
  })

  it('does not identify follow-up replay snapshots without a meta event', async () => {
    const { capturePosthogReplaySnapshot } = await import('../supabase/functions/_backend/utils/posthog.ts')

    await capturePosthogReplaySnapshot(createContext(), {
      currentUrl: 'capgo-cli://init',
      distinctId: 'user-id',
      events: [{ type: 2 }],
      lib: '@capgo/cli',
      libVersion: '8.9.0',
      sessionId: 'init-session',
      timestamp: '2026-06-16T00:00:00.000Z',
      userEmail: 'user@example.com',
      userId: 'user-id',
      windowId: 'window-id',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://eu.i.posthog.com/s/')
  })

  it('uses one deterministic insert ID for meta events repeated after resize', async () => {
    const { capturePosthogReplaySnapshot } = await import('../supabase/functions/_backend/utils/posthog.ts')
    const payload = {
      currentUrl: 'capgo-cli://init',
      distinctId: 'user-id',
      events: [{ type: 4 }],
      lib: '@capgo/cli',
      libVersion: '8.9.0',
      sessionId: 'init-session',
      timestamp: '2026-06-16T00:00:00.000Z',
      userEmail: 'user@example.com',
      userId: 'user-id',
      windowId: 'window-id',
    }

    await capturePosthogReplaySnapshot(createContext(), payload)
    await capturePosthogReplaySnapshot(createContext(), payload)

    const identifyBodies = [fetchMock.mock.calls[0], fetchMock.mock.calls[2]]
      .map(call => JSON.parse(call?.[1]?.body as string))
    expect(identifyBodies.map(body => body.properties.$insert_id)).toEqual([
      'cli-replay-identify:init-session',
      'cli-replay-identify:init-session',
    ])
  })

  it('still records when replay identification times out', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }))
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue('') })
    const { capturePosthogReplaySnapshot } = await import('../supabase/functions/_backend/utils/posthog.ts')

    const request = capturePosthogReplaySnapshot(createContext(), {
      currentUrl: 'capgo-cli://init',
      distinctId: 'user-id',
      events: [{ type: 4 }],
      lib: '@capgo/cli',
      libVersion: '8.9.0',
      sessionId: 'init-session',
      timestamp: '2026-06-16T00:00:00.000Z',
      userEmail: 'user@example.com',
      userId: 'user-id',
      windowId: 'window-id',
    })
    await vi.advanceTimersByTimeAsync(250)

    await expect(request).resolves.toBe(true)
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'https://eu.i.posthog.com/capture/',
      'https://eu.i.posthog.com/s/',
    ])
  })

  it('fails safely when replay identification receives an invalid PostHog host', async () => {
    const { capturePosthogReplaySnapshot } = await import('../supabase/functions/_backend/utils/posthog.ts')
    envState.posthogApiHost = '://bad-host'

    await expect(capturePosthogReplaySnapshot(createContext(), {
      currentUrl: 'capgo-cli://init',
      distinctId: 'user-id',
      events: [{ type: 4 }],
      lib: '@capgo/cli',
      libVersion: '8.9.0',
      sessionId: 'init-session',
      timestamp: '2026-06-16T00:00:00.000Z',
      userEmail: 'user@example.com',
      userId: 'user-id',
      windowId: 'window-id',
    })).resolves.toBe(false)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails safely when event tracking receives an invalid PostHog host', async () => {
    const { trackPosthogEvent } = await import('../supabase/functions/_backend/utils/posthog.ts')
    envState.posthogApiHost = '://bad-host'

    await expect(trackPosthogEvent(createContext(), {
      channel: 'test',
      event: 'test-event',
      user_id: 'user-id',
    })).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails safely when group identification receives an invalid PostHog host', async () => {
    const { groupIdentifyPosthog } = await import('../supabase/functions/_backend/utils/posthog.ts')
    envState.posthogApiHost = '://bad-host'

    await expect(groupIdentifyPosthog(createContext(), {
      groupKey: 'org-id',
      groupType: 'organization',
    })).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the full exception endpoint host and only sends the request path for exceptions', async () => {
    const { capturePosthogException } = await import('../supabase/functions/_backend/utils/posthog.ts')
    envState.posthogApiHost = 'https://eu.i.posthog.com/i/v0/e'

    await capturePosthogException(createContext(), {
      error: new Error('boom'),
      functionName: 'app',
      kind: 'unhandled_error',
      status: 500,
    })

    const request = fetchMock.mock.calls[0]
    const url = request?.[0]
    const body = JSON.parse(request?.[1]?.body as string)

    expect(url).toBe('https://eu.i.posthog.com/i/v0/e/')
    expect(body.event).toBe('$exception')
    expect(body.token).toBe('posthog-key')
    expect(body.properties.distinct_id).toBe('backend:prod:app')
    expect(body.properties.request_id).toBe('request-id')
    expect(body.properties.url_path).toBe('/functions/v1/app')
    expect(body.properties).not.toHaveProperty('url')
    expect(body.properties).not.toHaveProperty('$set')
    expect(body.properties.$exception_fingerprint).toContain('backend:prod:app')
    expect(body.properties.$exception_list[0].type).toBe('Error')
    expect(body.properties.$exception_list[0].value).toBe('boom')
    expect(body.properties.$exception_list[0].stacktrace.frames[0].platform).toBe('custom')
    expect(request?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('logs and skips exception delivery when the configured PostHog host is invalid', async () => {
    const { capturePosthogException } = await import('../supabase/functions/_backend/utils/posthog.ts')
    envState.posthogApiHost = '://bad-host'

    const sent = await capturePosthogException(createContext(), {
      error: new Error('boom'),
      functionName: 'app',
      kind: 'unhandled_error',
      status: 500,
    })

    expect(sent).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(cloudlogErrMock).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Invalid PostHog host',
      host: '://bad-host',
    }))
  })
})
