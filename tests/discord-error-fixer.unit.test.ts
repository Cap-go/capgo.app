import type { Context } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const backgroundTaskMock = vi.hoisted(() => vi.fn((_c: Context, task: Promise<unknown>) => task))

vi.mock('hono/adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hono/adapter')>()
  return {
    ...actual,
    env: vi.fn((c: Context) => (c as Context & { env?: Record<string, string | undefined> }).env ?? {}),
  }
})

vi.mock('../supabase/functions/_backend/utils/utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/utils.ts')>()
  return {
    ...actual,
    backgroundTask: backgroundTaskMock,
  }
})

const {
  buildErrorFixerWebhookPayload,
  resetErrorFixerWebhookThrottleForTests,
  sendDiscordAlert500,
  sendErrorFixerWebhookAlert,
} = await import('../supabase/functions/_backend/utils/discord.ts')

function createContext(environment: Record<string, string | undefined> = {}): Context {
  return {
    env: environment,
    get: (key: string) => key === 'requestId' ? 'req-test-1' : undefined,
    req: {
      method: 'POST',
      url: 'https://api.example.test/private/foo',
      header: (name: string) => {
        if (name === 'user-agent')
          return 'unit-test-agent'
        if (name === 'cf-connecting-ip')
          return '203.0.113.10'
        return undefined
      },
      raw: {
        headers: new Headers({
          'authorization': 'Bearer secret-token',
          'x-custom': 'visible',
        }),
      },
    },
  } as unknown as Context
}

function basePayload() {
  return buildErrorFixerWebhookPayload({
    functionName: 'test_fn',
    errorName: 'Error',
    message: 'first line\nsecond line',
    stack: 'stack-trace',
    method: 'POST',
    url: 'https://api.example.test/private/foo',
    requestId: 'req-test-1',
    timestamp: '2026-10-08T12:00:00.000Z',
    environment: 'test',
    userAgent: 'unit-test-agent',
    body: '{"ok":true}',
  })
}

describe('error fixer webhook', () => {
  beforeEach(() => {
    resetErrorFixerWebhookThrottleForTests()
    backgroundTaskMock.mockClear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    resetErrorFixerWebhookThrottleForTests()
  })

  it('skips when ERROR_FIXER_WEBHOOK_URL is unset', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await sendErrorFixerWebhookAlert(createContext(), basePayload())

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts a flat payload without headers or IP', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const payload = basePayload()
    await sendErrorFixerWebhookAlert(createContext({
      ERROR_FIXER_WEBHOOK_URL: 'https://fixer.example.test/hook',
      ERROR_FIXER_WEBHOOK_KEY: 'automation-key',
    }), payload)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://fixer.example.test/hook')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Authorization': 'Bearer automation-key',
      'X-Automation-Key': 'automation-key',
    })

    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toEqual(payload)
    expect(body).not.toHaveProperty('headers')
    expect(body).not.toHaveProperty('ip')
    expect(Object.keys(body).sort()).toEqual([
      'body',
      'environment',
      'errorName',
      'functionName',
      'message',
      'method',
      'requestId',
      'stack',
      'timestamp',
      'url',
      'userAgent',
    ].sort())
  })

  it('redacts sensitive query parameters from the forwarded URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const payload = buildErrorFixerWebhookPayload({
      ...basePayload(),
      url: 'https://api.example.test/reset?token=supersecretvalue&ok=1',
    })

    await sendErrorFixerWebhookAlert(createContext({
      ERROR_FIXER_WEBHOOK_URL: 'https://fixer.example.test/hook',
      ERROR_FIXER_WEBHOOK_KEY: 'automation-key',
    }), payload)

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as { url: string }
    expect(body.url).not.toContain('supersecretvalue')
    expect(body.url).toContain('ok=1')
  })

  it('truncates stack and body to 2000 characters', () => {
    const long = 'x'.repeat(2500)
    const payload = buildErrorFixerWebhookPayload({
      ...basePayload(),
      stack: long,
      body: long,
    })

    expect(payload.stack).toHaveLength(2000)
    expect(payload.body).toHaveLength(2000)
    expect(payload.stack).toBe(long.substring(0, 2000))
    expect(payload.body).toBe(long.substring(0, 2000))
  })

  it('throttles duplicate signatures for 10 minutes per isolate', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'))

    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const ctx = createContext({
      ERROR_FIXER_WEBHOOK_URL: 'https://fixer.example.test/hook',
      ERROR_FIXER_WEBHOOK_KEY: 'automation-key',
    })
    const payload = basePayload()

    await sendErrorFixerWebhookAlert(ctx, payload)
    await sendErrorFixerWebhookAlert(ctx, payload)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date('2026-10-08T12:09:59.000Z'))
    await sendErrorFixerWebhookAlert(ctx, payload)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date('2026-10-08T12:10:00.000Z'))
    await sendErrorFixerWebhookAlert(ctx, payload)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    vi.useRealTimers()
  })

  it('logs fetch failures without throwing', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(sendErrorFixerWebhookAlert(createContext({
      ERROR_FIXER_WEBHOOK_URL: 'https://fixer.example.test/hook',
      ERROR_FIXER_WEBHOOK_KEY: 'automation-key',
    }), basePayload())).resolves.toBeUndefined()

    expect(console.error).toHaveBeenCalled()
  })

  it('schedules error fixer forwarding from sendDiscordAlert500 via backgroundTask', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    sendDiscordAlert500(createContext({
      ERROR_FIXER_WEBHOOK_URL: 'https://fixer.example.test/hook',
      ERROR_FIXER_WEBHOOK_KEY: 'automation-key',
      ENVIRONMENT: 'test',
    }), 'my_fn', '{"hello":"world"}', new Error('boom'))

    expect(backgroundTaskMock).toHaveBeenCalledOnce()
    await backgroundTaskMock.mock.calls[0][1]

    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
