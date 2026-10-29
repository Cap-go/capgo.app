import { HTTPException } from 'hono/http-exception'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  backgroundTaskMock,
  capturePosthogExceptionMock,
  cloudlogErrMock,
  cloudlogMock,
  sendDiscordAlert500Mock,
} = vi.hoisted(() => ({
  backgroundTaskMock: vi.fn(),
  capturePosthogExceptionMock: vi.fn(),
  cloudlogErrMock: vi.fn(),
  cloudlogMock: vi.fn(),
  sendDiscordAlert500Mock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  backgroundTask: backgroundTaskMock,
}))

vi.mock('../supabase/functions/_backend/utils/discord.ts', () => ({
  sendDiscordAlert500: sendDiscordAlert500Mock,
}))

vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({
  capturePosthogException: capturePosthogExceptionMock,
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

function createContext(request?: Request) {
  return {
    get: (key: string) => key === 'requestId' ? 'request-id' : undefined,
    json: (body: unknown, status: number) => ({ body, status }),
    req: {
      method: request?.method ?? 'GET',
      raw: request ?? new Request('https://example.com/functions/v1/app', { method: 'GET' }),
      url: request?.url ?? 'https://example.com/functions/v1/app',
    },
  } as any
}

beforeEach(() => {
  backgroundTaskMock.mockImplementation((_c: unknown, promise: Promise<unknown>) => promise)
  capturePosthogExceptionMock.mockResolvedValue(true)
  sendDiscordAlert500Mock.mockResolvedValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
  backgroundTaskMock.mockReset()
  capturePosthogExceptionMock.mockReset()
  cloudlogErrMock.mockReset()
  cloudlogMock.mockReset()
  sendDiscordAlert500Mock.mockReset()
})

describe('onError PostHog capture', () => {
  it('redacts sensitive JSON request body fields before Discord alerts', async () => {
    const { onError } = await import('../supabase/functions/_backend/utils/on_error.ts')

    const error = new HTTPException(500, {
      cause: {
        error: 'internal_error',
        message: 'Something broke',
        moreInfo: {},
      },
    })

    const response = await onError('private')(error, createContext(new Request('https://example.com/functions/v1/private/accept_invitation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        captchaToken: 'captcha-secret',
        magic_invite_string: 'invite-secret',
        nested: {
          password: 'NestedPassword1!',
          id_token: 'apple-identity-token',
          first_name: 'PrivateFirstName',
          last_name: 'PrivateLastName',
          refresh_token: 'private-refresh-token',
          code: 'private-apple-authorization-code',
        },
        opt_for_newsletters: false,
        password: 'Password1!',
      }),
    })))

    expect(response.status).toBe(500)
    expect(sendDiscordAlert500Mock).toHaveBeenCalledOnce()

    const alertBody = sendDiscordAlert500Mock.mock.calls[0]?.[2]
    expect(alertBody).toBe(JSON.stringify({
      captchaToken: '[redacted]',
      magic_invite_string: '[redacted]',
      nested: {
        password: '[redacted]',
        id_token: '[redacted]',
        first_name: '[redacted]',
        last_name: '[redacted]',
        refresh_token: '[redacted]',
        code: '[redacted]',
      },
      opt_for_newsletters: false,
      password: '[redacted]',
    }))
    expect(alertBody).not.toContain('captcha-secret')
    expect(alertBody).not.toContain('invite-secret')
    expect(alertBody).not.toContain('NestedPassword1!')
    expect(alertBody).not.toContain('Password1!')
  })

  it('never copies build secrets or assistant conversations into alerts and redacts tokens in URLs', async () => {
    const { onError, SECRET_ROUTE_BODY_PLACEHOLDER } = await import('../supabase/functions/_backend/utils/on_error.ts')
    const secretBody = JSON.stringify({ P12_PASSWORD: 'p12-secret', APPLE_KEY_CONTENT: 'p8-secret', ANDROID_KEYSTORE_FILE: 'keystore-secret' })
    const urls = [
      'https://api.capgo.app/build/credentials/upload/payload.signature-secret',
      'https://api.capgo.app/build/credentials',
      'https://example.com/functions/v1/build/credentials/upload-url',
      'https://api.capgo.app/build/request',
      'https://api.capgo.app/private/assistant/responses',
      'https://example.com/functions/v1/private/assistant/responses',
    ]
    for (const url of urls) {
      sendDiscordAlert500Mock.mockClear()
      cloudlogErrMock.mockClear()
      const request = new Request(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: secretBody })
      const response = await onError('build')(new HTTPException(503, { cause: { error: 'database_unavailable', message: 'Cannot verify upload permission', moreInfo: {} } }), createContext(request))
      expect(response.status).toBe(503)
      expect(request.bodyUsed).toBe(false)
      expect(sendDiscordAlert500Mock).toHaveBeenCalledOnce()
      expect(sendDiscordAlert500Mock.mock.calls[0]?.[2]).toBe(SECRET_ROUTE_BODY_PLACEHOLDER)
      const logged = JSON.stringify(cloudlogErrMock.mock.calls)
      expect(logged).not.toContain('signature-secret')
      expect(logged).not.toContain('p12-secret')
    }
  })

  it('redacts secret-looking keys in alert bodies on any route', async () => {
    const { onError } = await import('../supabase/functions/_backend/utils/on_error.ts')
    await onError('private')(new HTTPException(500, { cause: { error: 'internal_error', message: 'boom', moreInfo: {} } }), createContext(new Request('https://example.com/functions/v1/private/something', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: 'com.example.app',
        P12_PASSWORD: 'p12-secret',
        nested: { APPLE_KEY_CONTENT: 'p8', BUILD_CERTIFICATE_BASE64: 'cert', BUILD_PROVISION_PROFILE_BASE64: 'prov', ANDROID_KEYSTORE_FILE: 'ks', PLAY_CONFIG_JSON: '{}', SENTRY_AUTH_TOKEN: 't', webhook_secret: 's', apikey: 'k' },
      }),
    })))
    expect(sendDiscordAlert500Mock.mock.calls[0]?.[2]).toBe(JSON.stringify({
      app_id: 'com.example.app',
      P12_PASSWORD: '[redacted]',
      nested: { APPLE_KEY_CONTENT: '[redacted]', BUILD_CERTIFICATE_BASE64: '[redacted]', BUILD_PROVISION_PROFILE_BASE64: '[redacted]', ANDROID_KEYSTORE_FILE: '[redacted]', PLAY_CONFIG_JSON: '[redacted]', SENTRY_AUTH_TOKEN: '[redacted]', webhook_secret: '[redacted]', apikey: '[redacted]' },
    }))
  })

  it('logs 4xx HTTP exceptions without console.error or stack so they stay out of Workers Issues', async () => {
    const { onError } = await import('../supabase/functions/_backend/utils/on_error.ts')

    const error = new HTTPException(400, {
      message: 'App ID must be a reverse domain string',
      cause: {
        error: 'invalid_app_id',
        message: 'App ID must be a reverse domain string',
        moreInfo: { app_id: 'bad' },
      },
    })

    const response = await onError('app')(error, createContext())

    expect(cloudlogErrMock).not.toHaveBeenCalled()
    expect(cloudlogMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'http_exception',
      status: 400,
      errorCode: 'invalid_app_id',
      errorMessage: 'App ID must be a reverse domain string',
    }))
    expect(cloudlogMock.mock.calls[0]?.[0]).not.toHaveProperty('stack')
    expect(sendDiscordAlert500Mock).not.toHaveBeenCalled()
    expect(capturePosthogExceptionMock).not.toHaveBeenCalled()
    expect(response).toEqual({
      body: {
        error: 'invalid_app_id',
        message: 'App ID must be a reverse domain string',
        moreInfo: { app_id: 'bad' },
      },
      status: 400,
    })
  })

  it('logs 5xx HTTP exceptions with console.error and stack', async () => {
    const { onError } = await import('../supabase/functions/_backend/utils/on_error.ts')

    const error = new HTTPException(500, {
      cause: { error: 'internal_error', message: 'Something broke', moreInfo: {} },
    })

    await onError('app')(error, createContext())

    expect(cloudlogMock).not.toHaveBeenCalled()
    expect(cloudlogErrMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'http_exception',
      status: 500,
      stack: expect.any(String),
    }))
  })

  it('captures backend HTTP exceptions in PostHog', async () => {
    const { onError } = await import('../supabase/functions/_backend/utils/on_error.ts')

    const error = new HTTPException(500, {
      cause: {
        error: 'internal_error',
        message: 'Something broke',
        moreInfo: { trace: 'abc' },
      },
    })

    const response = await onError('app')(error, createContext())

    expect(backgroundTaskMock).toHaveBeenCalledTimes(2)
    expect(backgroundTaskMock.mock.calls[0]?.[1]).toBeInstanceOf(Promise)
    expect(backgroundTaskMock.mock.calls[1]?.[1]).toBeInstanceOf(Promise)
    expect(sendDiscordAlert500Mock).toHaveBeenCalledOnce()
    expect(capturePosthogExceptionMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      functionName: 'app',
      kind: 'http_exception',
      status: 500,
    }))
    expect(capturePosthogExceptionMock.mock.calls[0]?.[1]).not.toHaveProperty('requestBody')
    expect(response).toEqual({
      body: {
        error: 'internal_error',
        message: 'Something broke',
        moreInfo: { trace: 'abc' },
      },
      status: 500,
    })
  })

  it('skips crash reporting for expected operational HTTP exceptions', async () => {
    const { onError } = await import('../supabase/functions/_backend/utils/on_error.ts')

    const error = new HTTPException(503, {
      cause: {
        error: 'service_unavailable',
        message: 'Build service unavailable',
        moreInfo: {},
        suppressDiscordAlert: true,
      },
    })

    const response = await onError('api')(error, createContext())

    expect(backgroundTaskMock).not.toHaveBeenCalled()
    expect(sendDiscordAlert500Mock).not.toHaveBeenCalled()
    expect(capturePosthogExceptionMock).not.toHaveBeenCalled()
    expect(response).toEqual({
      body: {
        error: 'service_unavailable',
        message: 'Build service unavailable',
        moreInfo: {},
      },
      status: 503,
    })
  })

  it('suppresses backend alerts for queue retries before the retry budget is exhausted', async () => {
    const { onError } = await import('../supabase/functions/_backend/utils/on_error.ts')

    const response = await onError('api')(new HTTPException(500, {
      cause: {
        error: 'analytics_engine_failed',
        message: 'Analytics Engine temporarily failed',
        moreInfo: {},
      },
    }), createContext(new Request('https://api.capgo.app/triggers/cron_stat_app', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-capgo-queue-max-reads': '5',
        'x-capgo-queue-name': 'cron_stat_app',
        'x-capgo-queue-read-count': '1',
      },
      body: JSON.stringify({ appId: 'com.example.app', orgId: 'org-id' }),
    })))

    expect(backgroundTaskMock).not.toHaveBeenCalled()
    expect(sendDiscordAlert500Mock).not.toHaveBeenCalled()
    expect(capturePosthogExceptionMock).not.toHaveBeenCalled()
    expect(response.status).toBe(500)
  })

  it('keeps backend alerts for queue retries that exhausted the retry budget', async () => {
    const { onError } = await import('../supabase/functions/_backend/utils/on_error.ts')

    const response = await onError('api')(new HTTPException(500, {
      cause: {
        error: 'analytics_engine_failed',
        message: 'Analytics Engine still failed',
        moreInfo: {},
      },
    }), createContext(new Request('https://api.capgo.app/triggers/cron_stat_app', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-capgo-queue-max-reads': '5',
        'x-capgo-queue-name': 'cron_stat_app',
        'x-capgo-queue-read-count': '5',
      },
      body: JSON.stringify({ appId: 'com.example.app', orgId: 'org-id' }),
    })))

    expect(backgroundTaskMock).toHaveBeenCalledTimes(2)
    expect(sendDiscordAlert500Mock).toHaveBeenCalledOnce()
    expect(capturePosthogExceptionMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      functionName: 'api',
      kind: 'http_exception',
      status: 500,
    }))
    expect(response.status).toBe(500)
  })

  it('skips PostHog capture for client HTTP exceptions', async () => {
    const { onError } = await import('../supabase/functions/_backend/utils/on_error.ts')

    const response = await onError('app')(new HTTPException(400, {
      cause: {
        error: 'bad_request',
        message: 'Invalid input',
        moreInfo: {},
      },
    }), createContext())

    expect(backgroundTaskMock).not.toHaveBeenCalled()
    expect(sendDiscordAlert500Mock).not.toHaveBeenCalled()
    expect(capturePosthogExceptionMock).not.toHaveBeenCalled()
    expect(response).toEqual({
      body: {
        error: 'bad_request',
        message: 'Invalid input',
        moreInfo: {},
      },
      status: 400,
    })
  })

  it('captures Drizzle-style errors in PostHog', async () => {
    const { onError } = await import('../supabase/functions/_backend/utils/on_error.ts')

    const response = await onError('app')({
      cause: new Error('query failed'),
      message: 'db failed',
      name: 'DrizzleError',
    }, createContext())

    expect(backgroundTaskMock).toHaveBeenCalledTimes(2)
    expect(backgroundTaskMock.mock.calls[0]?.[1]).toBeInstanceOf(Promise)
    expect(backgroundTaskMock.mock.calls[1]?.[1]).toBeInstanceOf(Promise)
    expect(sendDiscordAlert500Mock).toHaveBeenCalledOnce()
    expect(capturePosthogExceptionMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      functionName: 'app',
      kind: 'drizzle_error',
      status: 500,
    }))
    expect(response).toEqual({
      body: {
        error: 'unknown_error',
        message: 'Unknown error',
        moreInfo: {},
      },
      status: 500,
    })
  })

  const pgTerminated = () => Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' })
  const notificationsRequest = () => new Request('https://api.capgo.app/notifications/settings?app_id=com.demo.app')

  interface TransientCase { name: string, error: () => unknown, makeRequest: () => Request | undefined, logsPgCode?: boolean }
  it.each<TransientCase>([
    {
      name: 'transient Drizzle errors',
      error: () => ({
        cause: pgTerminated(),
        message: `Failed query:
      SELECT app_id, push_update_enabled
      FROM public.notification_app_settings
      WHERE app_id = $1
    `,
        name: 'DrizzleQueryError',
      }),
      makeRequest: notificationsRequest,
    },
    { name: 'transient native pg errors', error: pgTerminated, makeRequest: notificationsRequest, logsPgCode: true },
    {
      name: 'transient database errors wrapped in quickError',
      error: () => new HTTPException(500, {
        cause: {
          error: 'failed_to_load_settings',
          message: 'Failed to load notification settings',
          moreInfo: {},
          originalCause: pgTerminated(),
        },
      }),
      makeRequest: () => undefined,
    },
  ])('returns 503 without PostHog capture for $name', async ({ error, makeRequest, logsPgCode }) => {
    const { onError } = await import('../supabase/functions/_backend/utils/on_error.ts')

    const response = await onError('api')(error() as any, createContext(makeRequest()))

    expect(backgroundTaskMock).not.toHaveBeenCalled()
    expect(sendDiscordAlert500Mock).not.toHaveBeenCalled()
    expect(capturePosthogExceptionMock).not.toHaveBeenCalled()
    if (logsPgCode) {
      expect(cloudlogErrMock).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'transient_pg_error',
        moreInfo: { pgErrorCode: '57P01' },
      }))
    }
    expect(response).toEqual({
      body: {
        error: 'upstream_unavailable',
        message: 'Database temporarily unavailable',
        moreInfo: {},
      },
      status: 503,
    })
  })

  it('does not treat unrelated transient network errors as database outages', async () => {
    const { onError } = await import('../supabase/functions/_backend/utils/on_error.ts')

    const response = await onError('api')(Object.assign(new Error('fetch failed'), {
      code: 'ECONNREFUSED',
      cause: Object.assign(new Error('connect ECONNREFUSED api.stripe.com:443'), {
        code: 'ECONNREFUSED',
      }),
    }), createContext())

    expect(response.status).toBe(500)
    expect(response.body).toEqual({
      error: 'unknown_error',
      message: 'Unknown error',
      moreInfo: {},
    })
    expect(sendDiscordAlert500Mock).toHaveBeenCalledOnce()
    expect(capturePosthogExceptionMock).toHaveBeenCalledOnce()
  })

  const doTimeoutMessage = 'Durable Object storage operation exceeded timeout which caused object to be reset.'
  it.each([
    {
      name: 'expected files Durable Object storage timeouts',
      functionName: 'files',
      error: () => Object.assign(new Error(doTimeoutMessage), { durableObjectReset: true, overloaded: true }),
      backgroundCalls: 1,
    },
    { name: 'expected TUS handler Durable Object storage timeouts', functionName: 'TUS handler', error: () => new Error(doTimeoutMessage), backgroundCalls: 1 },
    { name: 'Cloudflare internal errors on the files upload path', functionName: 'files', error: () => new Error('internal error; reference = 0123abcd-4567-89ef') },
  ])('skips Discord for $name', async ({ functionName, error, backgroundCalls }) => {
    const { onError } = await import('../supabase/functions/_backend/utils/on_error.ts')

    const response = await onError(functionName)(error(), createContext())

    if (backgroundCalls !== undefined) {
      expect(backgroundTaskMock).toHaveBeenCalledTimes(backgroundCalls)
      expect(backgroundTaskMock.mock.calls[0]?.[1]).toBeInstanceOf(Promise)
    }
    expect(sendDiscordAlert500Mock).not.toHaveBeenCalled()
    expect(capturePosthogExceptionMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      functionName,
      kind: 'unhandled_error',
      status: 500,
    }))
    expect(response).toEqual({
      body: {
        error: 'unknown_error',
        message: 'Unknown error',
        moreInfo: {},
      },
      status: 500,
    })
  })

  it('captures generic unhandled errors in PostHog', async () => {
    const { onError } = await import('../supabase/functions/_backend/utils/on_error.ts')

    const response = await onError('app')(new Error('boom'), createContext())

    expect(backgroundTaskMock).toHaveBeenCalledTimes(2)
    expect(backgroundTaskMock.mock.calls[0]?.[1]).toBeInstanceOf(Promise)
    expect(backgroundTaskMock.mock.calls[1]?.[1]).toBeInstanceOf(Promise)
    expect(sendDiscordAlert500Mock).toHaveBeenCalledOnce()
    expect(capturePosthogExceptionMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      functionName: 'app',
      kind: 'unhandled_error',
      status: 500,
    }))
    expect(response).toEqual({
      body: {
        error: 'unknown_error',
        message: 'Unknown error',
        moreInfo: {},
      },
      status: 500,
    })
  })
})
