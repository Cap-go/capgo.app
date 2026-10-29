import type { Context, Next } from 'hono'
import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({
  middlewareAuth: () => async (c: Context<MiddlewareKeyVariables>, next: Next) => {
    const authorization = c.req.header('authorization')
    if (!['Bearer console-session', 'Bearer api-key', 'Bearer service-session'].includes(authorization ?? ''))
      return c.json({ error: 'invalid_jwt' }, 401)
    c.set('auth', {
      userId: '00000000-0000-4000-8000-000000000001',
      authType: authorization === 'Bearer api-key' ? 'apikey' : 'jwt',
      jwt: null,
      apikey: null,
      claims: { sub: '00000000-0000-4000-8000-000000000001', role: authorization === 'Bearer service-session' ? 'service_role' : 'authenticated' },
    })
    await next()
  },
}))

const { app: assistant } = await import('../supabase/functions/_backend/private/assistant.ts')
const app = new Hono<MiddlewareKeyVariables>()
app.route('/private/assistant', assistant)
app.onError((error, c) => {
  if (error instanceof HTTPException)
    return c.json(error.cause ?? { error: error.message }, error.status)
  throw error
})

const headers = { authorization: 'Bearer console-session', 'x-chatgpt-token': 'chatgpt-access-token', 'content-type': 'application/json', origin: 'https://console.capgo.app' }
const payload = { model: 'test-model', input: [{ role: 'user', content: 'Hello' }], store: false, stream: true }
const fetchMock = vi.fn<typeof fetch>()

describe('authenticated assistant proxy', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each([undefined, 'Bearer invalid', 'Bearer api-key', 'Bearer service-session'])('rejects unauthorized caller %s before contacting OpenAI', async (authorization) => {
    const requestHeaders = new Headers(headers)
    if (authorization)
      requestHeaders.set('authorization', authorization)
    else
      requestHeaders.delete('authorization')
    const response = await app.request('/private/assistant/models', { headers: requestHeaders })
    expect(response.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['', 'has spaces', 'x'.repeat(16_385)])('rejects missing or invalid ChatGPT credentials', async (token) => {
    const response = await app.request('/private/assistant/models', { headers: { ...headers, 'x-chatgpt-token': token } })
    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('only forwards the ChatGPT credential to the fixed OpenAI models URL', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ models: [{ slug: 'test-model' }] }, {
      headers: { 'set-cookie': 'upstream=secret', 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': 'https://other.example' },
    }))
    const response = await app.request('/private/assistant/models?url=https://other.example', {
      headers: { ...headers, cookie: 'private-cookie', 'x-api-key': 'private-capgo-key' },
    })
    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.objectContaining({
      method: 'GET', headers: { authorization: 'Bearer chatgpt-access-token', accept: 'application/json' }, redirect: 'manual',
    }))
    await expect(response.json()).resolves.toEqual({ models: [{ slug: 'test-model' }] })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('access-control-allow-origin')).toBe('https://console.capgo.app')
  })

  it('streams response chunks without waiting for completion', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const upstream = new ReadableStream<Uint8Array>({ start(streamController) { controller = streamController } })
    fetchMock.mockResolvedValueOnce(new Response(upstream, { headers: { 'content-type': 'text/event-stream' } }))
    const response = await app.request('/private/assistant/responses', { method: 'POST', headers, body: JSON.stringify(payload) })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/responses', expect.objectContaining({
      method: 'POST', body: JSON.stringify(payload), redirect: 'manual',
      headers: { authorization: 'Bearer chatgpt-access-token', accept: 'text/event-stream', 'content-type': 'application/json' },
    }))
    const reader = response.body!.getReader()
    const chunk = 'data: {"type":"response.created"}\n\n'
    controller.enqueue(new TextEncoder().encode(chunk))
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe(chunk)
    expect(first.done).toBe(false)
    controller.close()
    expect((await reader.read()).done).toBe(true)
  })

  it.each([401, 403, 429, 500])('preserves upstream error status %s and retry headers', async (status) => {
    const error = { error: { code: status === 429 ? 'subscription_sharing_usage_limit_exceeded' : 'upstream_error' } }
    fetchMock.mockResolvedValueOnce(Response.json(error, { status, headers: { 'retry-after': '30' } }))
    const response = await app.request('/private/assistant/responses', { method: 'POST', headers, body: JSON.stringify(payload) })
    expect(response.status).toBe(status)
    expect(response.headers.get('retry-after')).toBe('30')
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual(error)
  })

  it.each([
    { body: '{', status: 400 },
    { body: JSON.stringify({ ...payload, store: true }), status: 400 },
    { body: JSON.stringify({ ...payload, stream: false }), status: 400 },
    { body: 'null', status: 400 },
    { body: '[]', status: 400 },
    { body: 'x'.repeat(1024 * 1024 + 1), status: 413 },
  ])('rejects invalid or oversized response payloads ($status)', async ({ body, status }) => {
    const response = await app.request('/private/assistant/responses', { method: 'POST', headers, body })
    expect(response.status).toBe(status)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects non-JSON request bodies', async () => {
    const response = await app.request('/private/assistant/responses', {
      method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: JSON.stringify(payload),
    })
    expect(response.status).toBe(415)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    { path: '/private/assistant/models', method: 'POST' },
    { path: '/private/assistant/responses', method: 'GET' },
    { path: '/private/assistant/token', method: 'POST' },
    { path: '/private/assistant/responses/extra', method: 'POST' },
  ])('does not proxy unsupported routes ($method $path)', async ({ path, method }) => {
    const response = await app.request(path, { method, headers })
    expect(response.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not follow redirects or expose upstream cookies', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: 'https://other.example', 'set-cookie': 'secret' } }))
    const response = await app.request('/private/assistant/models', { headers })
    expect(response.status).toBe(502)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('returns a sanitized error when the upstream connection fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('contains-chatgpt-access-token'))
    const response = await app.request('/private/assistant/models', { headers })
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('chatgpt-access-token')
  })

  it('propagates client cancellation to the upstream request', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ models: [] }))
    const controller = new AbortController()
    const request = new Request('https://api.capgo.test/private/assistant/models', { headers, signal: controller.signal })
    await app.request(request)
    const signal = fetchMock.mock.calls[0][1]?.signal
    expect(signal?.aborted).toBe(false)
    controller.abort()
    expect(signal?.aborted).toBe(true)
  })
})
