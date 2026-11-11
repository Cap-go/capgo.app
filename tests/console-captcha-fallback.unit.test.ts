import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/private/console_captcha_fallback'

const fetchMock = vi.fn()
let env: Record<string, string> = {}

vi.mock('../supabase/functions/_backend/utils/hono.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/hono.ts')>(),
  quickError: (status: number, error: string, message?: string, moreInfo?: Record<string, unknown>) =>
    Response.json({ error, message, moreInfo }, { status }),
}))
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: (_c: unknown, key: string) => env[key] ?? '',
}))

beforeEach(() => {
  env = {
    CAPTCHA_SECRET_KEY: 'turnstile-secret',
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
    SUPABASE_URL: 'https://auth.example.co/',
    WEBAPP_URL: 'https://console.capgo.app/',
  }
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
})

afterEach(() => vi.unstubAllGlobals())

describe('console captcha fallback', () => {
  it('rejects without captcha secret configured', async () => {
    env = { ...env, CAPTCHA_SECRET_KEY: '' }
    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://console.capgo.app' },
      body: JSON.stringify({ email: 'user@example.com', purpose: 'magic_link' }),
    })
    expect(response.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends magic link otp without password and without captcha token', async () => {
    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://console.capgo.app',
        'cf-connecting-ip': '203.0.113.50',
      },
      body: JSON.stringify({ email: 'user@example.com', purpose: 'magic_link' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://auth.example.co/auth/v1/otp')
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('apikey')).toBe('sb_secret_test')
    expect(headers.get('sb-forwarded-for')).toBe('203.0.113.50')
    expect(JSON.parse(String(init.body))).toEqual({ email: 'user@example.com', create_user: false, data: {} })
  })

  it('returns operational failure for invalid relay credentials', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))
    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://console.capgo.app' },
      body: JSON.stringify({ email: 'user@example.com', purpose: 'magic_link' }),
    })
    expect(response.status).toBe(503)
    const payload = await response.json() as { error?: string }
    expect(payload.error).toBe('captcha_fallback_failed')
  })

  it('still returns ok for other upstream client errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 422 }))
    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://console.capgo.app' },
      body: JSON.stringify({ email: 'unknown@example.com', purpose: 'magic_link' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  it('surfaces upstream rate limits instead of a generic ok', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 429 }))
    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://console.capgo.app' },
      body: JSON.stringify({ email: 'user@example.com', purpose: 'magic_link' }),
    })
    expect(response.status).toBe(429)
    expect(await response.text()).toContain('Too many requests')
  })

  it('never exposes a password grant path on this endpoint', async () => {
    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://console.capgo.app' },
      body: JSON.stringify({ email: 'user@example.com', purpose: 'magic_link' }),
    })
    expect(response.status).toBe(200)
    const upstreamBody = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(upstreamBody).not.toHaveProperty('password')
    expect(upstreamBody).not.toHaveProperty('grant_type')
  })
})
