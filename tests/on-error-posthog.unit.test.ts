import { HTTPException } from 'hono/http-exception'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  backgroundTaskMock,
  capturePosthogExceptionMock,
  cloudlogErrMock,
  sendDiscordAlert500Mock,
} = vi.hoisted(() => ({
  backgroundTaskMock: vi.fn(),
  capturePosthogExceptionMock: vi.fn(),
  cloudlogErrMock: vi.fn(),
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
      },
      opt_for_newsletters: false,
      password: '[redacted]',
    }))
    expect(alertBody).not.toContain('captcha-secret')
    expect(alertBody).not.toContain('invite-secret')
    expect(alertBody).not.toContain('NestedPassword1!')
    expect(alertBody).not.toContain('Password1!')
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

  it('skips Discord for expected files Durable Object storage timeouts', async () => {
    const { onError } = await import('../supabase/functions/_backend/utils/on_error.ts')

    const error = Object.assign(
      new Error('Durable Object storage operation exceeded timeout which caused object to be reset.'),
      {
        durableObjectReset: true,
        overloaded: true,
      },
    )

    const response = await onError('files')(error, createContext())

    expect(backgroundTaskMock).toHaveBeenCalledTimes(1)
    expect(backgroundTaskMock.mock.calls[0]?.[1]).toBeInstanceOf(Promise)
    expect(sendDiscordAlert500Mock).not.toHaveBeenCalled()
    expect(capturePosthogExceptionMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      functionName: 'files',
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

  it('skips Discord for expected TUS handler Durable Object storage timeouts', async () => {
    const { onError } = await import('../supabase/functions/_backend/utils/on_error.ts')

    const response = await onError('TUS handler')(new Error('Durable Object storage operation exceeded timeout which caused object to be reset.'), createContext())

    expect(backgroundTaskMock).toHaveBeenCalledTimes(1)
    expect(sendDiscordAlert500Mock).not.toHaveBeenCalled()
    expect(capturePosthogExceptionMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      functionName: 'TUS handler',
      kind: 'unhandled_error',
      status: 500,
    }))
    expect(response.status).toBe(500)
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
