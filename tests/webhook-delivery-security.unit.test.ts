import { afterEach, describe, expect, it, vi } from 'vitest'

const { mockGetEnv, mockCloudlog, mockCloudlogErr } = vi.hoisted(() => ({
  mockGetEnv: vi.fn(),
  mockCloudlog: vi.fn(),
  mockCloudlogErr: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: mockGetEnv,
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: mockCloudlog,
  cloudlogErr: mockCloudlogErr,
  serializeError: (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
}))

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'request-id' : undefined,
  } as any
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  mockGetEnv.mockReset()
  mockCloudlog.mockReset()
  mockCloudlogErr.mockReset()
  mockGetEnv.mockReturnValue('')
})

describe('webhook delivery redirect handling', () => {
  it('sends webhook requests with manual redirect handling', async () => {
    mockGetEnv.mockReturnValue('')
    const fetchMock = vi.fn().mockImplementation(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { deliverWebhook } = await import('../supabase/functions/_backend/utils/webhook.ts')
    const result = await deliverWebhook(
      createContext(),
      'delivery-1',
      'https://example.com/webhook',
      {
        type: 'app_versions.INSERT',
        event: 'app_versions.INSERT',
        event_id: 'event-1',
        timestamp: new Date().toISOString(),
        org_id: 'org-1',
        data: {
          table: 'app_versions',
          operation: 'INSERT',
          record_id: 'record-1',
          old_record: null,
          new_record: null,
          changed_fields: null,
        },
      },
      'secret',
      'standard',
    )

    expect(result.success).toBe(true)
    const webhookCalls = fetchMock.mock.calls.filter(([url]) => url === 'https://example.com/webhook')
    expect(webhookCalls).toHaveLength(1)
    expect(webhookCalls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'manual',
    })
    expect((webhookCalls[0]?.[1]?.headers as Record<string, string>)['webhook-id']).toBe('event-1')
    expect((webhookCalls[0]?.[1]?.headers as Record<string, string>)['webhook-timestamp']).toMatch(/^\d+$/)
    expect((webhookCalls[0]?.[1]?.headers as Record<string, string>)['webhook-signature']).toMatch(/^v1,[A-Za-z0-9+/]+={0,2}$/)
    expect((webhookCalls[0]?.[1]?.headers as Record<string, string>)['X-Capgo-Signature']).toMatch(/^v1=\d+\.[a-f0-9]{64}$/)
  })

  it('uses the legacy payload and headers by default', async () => {
    mockGetEnv.mockReturnValue('')
    const fetchMock = vi.fn().mockImplementation(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { deliverWebhook } = await import('../supabase/functions/_backend/utils/webhook.ts')
    const result = await deliverWebhook(
      createContext(),
      'delivery-legacy',
      'https://example.com/webhook',
      {
        type: 'app_versions.INSERT',
        event: 'app_versions.INSERT',
        event_id: 'event-legacy',
        timestamp: new Date().toISOString(),
        org_id: 'org-1',
        data: {
          table: 'app_versions',
          operation: 'INSERT',
          record_id: 'record-legacy',
          old_record: null,
          new_record: null,
          changed_fields: null,
        },
      },
      'secret',
    )

    expect(result.success).toBe(true)
    const webhookCalls = fetchMock.mock.calls.filter(([url]) => url === 'https://example.com/webhook')
    expect(webhookCalls).toHaveLength(1)
    const headers = webhookCalls[0]?.[1]?.headers as Record<string, string>
    const body = JSON.parse(webhookCalls[0]?.[1]?.body as string) as Record<string, unknown>
    expect(headers['webhook-id']).toBeUndefined()
    expect(headers['webhook-signature']).toBeUndefined()
    expect(headers['X-Capgo-Event-ID']).toBe('event-legacy')
    expect(headers['X-Capgo-Signature']).toMatch(/^v1=\d+\.[a-f0-9]{64}$/)
    expect(body.type).toBeUndefined()
    expect(body.event).toBe('app_versions.INSERT')
  })

  it('does not treat redirect responses as successful deliveries', async () => {
    mockGetEnv.mockReturnValue('')
    const fetchMock = vi.fn().mockResolvedValue(new Response('', {
      status: 302,
      headers: {
        location: 'http://169.254.169.254/latest/meta-data/',
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const { deliverWebhook } = await import('../supabase/functions/_backend/utils/webhook.ts')
    const result = await deliverWebhook(
      createContext(),
      'delivery-2',
      'https://example.com/webhook',
      {
        type: 'app_versions.INSERT',
        event: 'app_versions.INSERT',
        event_id: 'event-2',
        timestamp: new Date().toISOString(),
        org_id: 'org-1',
        data: {
          table: 'app_versions',
          operation: 'INSERT',
          record_id: 'record-2',
          old_record: null,
          new_record: null,
          changed_fields: null,
        },
      },
      'secret',
      'standard',
    )

    expect(result.success).toBe(false)
    expect(result.status).toBe(302)
    const webhookCalls = fetchMock.mock.calls.filter(([url]) => url === 'https://example.com/webhook')
    expect(webhookCalls).toHaveLength(1)
  })

  it('caps response bodies while reading webhook delivery previews', async () => {
    mockGetEnv.mockReturnValue('')
    let streamCancelled = false
    const oversizedChunk = new Uint8Array(12000).fill('a'.charCodeAt(0))
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversizedChunk)
      },
      cancel() {
        streamCancelled = true
      },
    })
    const fetchMock = vi.fn().mockResolvedValue(new Response(responseBody, { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    const { deliverWebhook } = await import('../supabase/functions/_backend/utils/webhook.ts')
    const result = await deliverWebhook(
      createContext(),
      'delivery-large-body',
      'https://example.com/webhook',
      {
        type: 'app_versions.INSERT',
        event: 'app_versions.INSERT',
        event_id: 'event-large-body',
        timestamp: new Date().toISOString(),
        org_id: 'org-1',
        data: {
          table: 'app_versions',
          operation: 'INSERT',
          record_id: 'record-large-body',
          old_record: null,
          new_record: null,
          changed_fields: null,
        },
      },
      'secret',
      'standard',
    )

    expect(result.success).toBe(false)
    expect(result.body).toHaveLength(10000)
    expect(streamCancelled).toBe(true)
  })

  it('does not log raw webhook URLs or query secrets', async () => {
    mockGetEnv.mockReturnValue('')
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlString = String(input)
      const url = new URL(urlString)

      if (url.hostname === 'cloudflare-dns.com') {
        return new Response(JSON.stringify({
          Answer: [{ data: '93.184.216.34' }],
        }))
      }

      return new Response('ok', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { deliverWebhook } = await import('../supabase/functions/_backend/utils/webhook.ts')
    const result = await deliverWebhook(
      createContext(),
      'delivery-sensitive-url',
      'https://example.com/hooks/capgo?token=secret-token',
      {
        type: 'app_versions.INSERT',
        event: 'app_versions.INSERT',
        event_id: 'event-sensitive-url',
        timestamp: new Date().toISOString(),
        org_id: 'org-1',
        data: {
          table: 'app_versions',
          operation: 'INSERT',
          record_id: 'record-sensitive-url',
          old_record: null,
          new_record: null,
          changed_fields: null,
        },
      },
      'secret',
      'standard',
    )

    expect(result.success).toBe(true)
    const deliveryLog = mockCloudlog.mock.calls
      .map(([entry]) => entry)
      .find(entry => entry.message === 'Webhook delivery attempt')

    expect(deliveryLog).toMatchObject({
      urlInfo: {
        valid: true,
        protocol: 'https',
        hostnameLength: 'example.com'.length,
        pathSegmentCount: 2,
        hasQuery: true,
        hasCredentials: false,
      },
    })
    expect(deliveryLog).not.toHaveProperty('url')
    expect(JSON.stringify(deliveryLog)).not.toContain('secret-token')
  })

  it('does not log raw webhook URLs when delivery fails before a response', async () => {
    mockGetEnv.mockReturnValue('')
    const fetchMock = vi.fn().mockRejectedValue(new Error('receiver unavailable'))
    vi.stubGlobal('fetch', fetchMock)

    const { deliverWebhook } = await import('../supabase/functions/_backend/utils/webhook.ts')
    const result = await deliverWebhook(
      createContext(),
      'delivery-sensitive-failure',
      'https://example.com/hooks/capgo?token=secret-token',
      {
        type: 'app_versions.INSERT',
        event: 'app_versions.INSERT',
        event_id: 'event-sensitive-failure',
        timestamp: new Date().toISOString(),
        org_id: 'org-1',
        data: {
          table: 'app_versions',
          operation: 'INSERT',
          record_id: 'record-sensitive-failure',
          old_record: null,
          new_record: null,
          changed_fields: null,
        },
      },
      'secret',
      'standard',
    )

    expect(result.success).toBe(false)
    const deliveryLog = mockCloudlogErr.mock.calls
      .map(([entry]) => entry)
      .find(entry => entry.message === 'Webhook delivery failed')

    expect(deliveryLog).toMatchObject({
      urlInfo: {
        valid: true,
        protocol: 'https',
        hostnameLength: 'example.com'.length,
        pathSegmentCount: 2,
        hasQuery: true,
        hasCredentials: false,
      },
    })
    expect(deliveryLog).not.toHaveProperty('url')
    expect(JSON.stringify(deliveryLog)).not.toContain('secret-token')
  })

  it('blocks webhook hosts that resolve to private addresses before delivery', async () => {
    mockGetEnv.mockReturnValue('')
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const urlString = String(input)
      const url = new URL(urlString)

      if (url.hostname === 'cloudflare-dns.com') {
        const type = url.searchParams.get('type')
        return new Response(JSON.stringify({
          Answer: type === 'A' ? [{ data: '127.0.0.1' }] : [],
        }))
      }

      return new Response('should not post', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { deliverWebhook } = await import('../supabase/functions/_backend/utils/webhook.ts')
    const result = await deliverWebhook(
      createContext(),
      'delivery-3',
      'https://private.example/webhook?token=secret-token',
      {
        type: 'app_versions.INSERT',
        event: 'app_versions.INSERT',
        event_id: 'event-3',
        timestamp: new Date().toISOString(),
        org_id: 'org-1',
        data: {
          table: 'app_versions',
          operation: 'INSERT',
          record_id: 'record-3',
          old_record: null,
          new_record: null,
          changed_fields: null,
        },
      },
      'secret',
      'standard',
    )

    expect(result).toMatchObject({
      success: false,
      body: 'Error: Webhook URL must point to a public host',
    })
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('https://private.example/'))).toBe(false)
    const blockedLog = mockCloudlogErr.mock.calls
      .map(([entry]) => entry)
      .find(entry => entry.message === 'Webhook delivery blocked by URL validation')
    expect(blockedLog).not.toHaveProperty('url')
    expect(JSON.stringify(blockedLog)).not.toContain('secret-token')
  })
})

describe('webhook retry scheduling', () => {
  it('uses the multi-day retry schedule with deterministic jitter', async () => {
    const { getWebhookRetryDelaySeconds } = await import('../supabase/functions/_backend/utils/webhook.ts')

    expect(getWebhookRetryDelaySeconds(1, null, 500, 0.5)).toBe(5)
    expect(getWebhookRetryDelaySeconds(2, null, 500, 0.5)).toBe(5 * 60)
    expect(getWebhookRetryDelaySeconds(3, null, 500, 0.5)).toBe(30 * 60)
    expect(getWebhookRetryDelaySeconds(4, null, 500, 0.5)).toBe(2 * 60 * 60)
    expect(getWebhookRetryDelaySeconds(9, null, 500, 0.5)).toBe(2 * 60 * 60)
  })

  it('honors retry-after and throttles rate-limit responses', async () => {
    const { getWebhookRetryDelaySeconds, parseRetryAfterSeconds } = await import('../supabase/functions/_backend/utils/webhook.ts')

    expect(parseRetryAfterSeconds('120')).toBe(120)
    expect(getWebhookRetryDelaySeconds(1, '600', 429, 0.5)).toBe(600)
    expect(getWebhookRetryDelaySeconds(1, null, 429, 0.5)).toBe(5 * 60)
    expect(getWebhookRetryDelaySeconds(1, '600', 429, 0)).toBe(600)
    expect(getWebhookRetryDelaySeconds(1, null, 429, 0)).toBe(5 * 60)
  })
})
