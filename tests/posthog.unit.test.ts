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

  it('sends replay snapshots with backend identity email', async () => {
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

    const request = fetchMock.mock.calls[0]
    const body = JSON.parse(request?.[1]?.body as string)

    expect(request?.[0]).toBe('https://eu.i.posthog.com/s/')
    expect(body.event).toBe('$snapshot')
    expect(body.api_key).toBe('posthog-key')
    expect(body.distinct_id).toBe('user-id')
    expect(body.properties.$set).toEqual({ email: 'user@example.com' })
    expect(body.properties.token).toBe('posthog-key')
    expect(body.properties.user_id).toBe('user-id')
    expect(body.properties.$session_id).toBe('init-session')
    expect(body.properties.$window_id).toBe('window-id')
    expect(body.properties.$snapshot_data).toHaveLength(1)
    expect(request?.[1]?.signal).toBeInstanceOf(AbortSignal)
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
