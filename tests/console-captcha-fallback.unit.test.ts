import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HTTPException } from 'hono/http-exception'
import * as rateLimitModule from '../supabase/functions/_backend/utils/rate_limit.ts'
import * as domainEnforcementModule from '../supabase/functions/_backend/private/sso/domain-enforcement.ts'
import { app } from '../supabase/functions/_backend/private/console_captcha_fallback'

const fetchMock = vi.fn()
let env: Record<string, string> = {}

vi.mock('../supabase/functions/_backend/utils/hono.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../supabase/functions/_backend/utils/hono.ts')>()
  return { ...original }
})
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: (_c: unknown, key: string) => env[key] ?? '',
}))

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    const cause = err.cause as { error?: string, message?: string, moreInfo?: Record<string, unknown> } | undefined
    return c.json({
      error: cause?.error ?? 'error',
      message: cause?.message ?? err.message,
      moreInfo: cause?.moreInfo ?? {},
    }, err.status)
  }
  throw err
})

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
  vi.spyOn(domainEnforcementModule, 'isEmailDomainSsoEnforced').mockResolvedValue(false)
  vi.spyOn(rateLimitModule, 'reserveCaptchaFallbackQuota').mockResolvedValue({ limited: false })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

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

  it('rejects requests with a missing Origin header', async () => {
    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', purpose: 'magic_link' }),
    })
    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects requests with a disallowed Origin header', async () => {
    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'user@example.com', purpose: 'magic_link' }),
    })
    expect(response.status).toBe(403)
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

  it('refuses magic link when SSO is enforced for the email domain', async () => {
    vi.mocked(domainEnforcementModule.isEmailDomainSsoEnforced).mockResolvedValueOnce(true)

    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://console.capgo.app' },
      body: JSON.stringify({ email: 'user@sso-org.com', purpose: 'magic_link' }),
    })

    expect(response.status).toBe(403)
    const payload = await response.json() as { error?: string }
    expect(payload.error).toBe('sso_enforced')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('relays the submitted email to auth while rate limits use normalized quota keys', async () => {
    const recordSpy = vi.spyOn(rateLimitModule, 'reserveCaptchaFallbackQuota')
    const submitted = 'John.Doe+promo@gmail.com'

    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://console.capgo.app' },
      body: JSON.stringify({ email: submitted, purpose: 'magic_link' }),
    })
    expect(response.status).toBe(200)

    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).email).toBe(submitted)
    expect(recordSpy).toHaveBeenCalledWith(expect.anything(), 'johndoe@gmail.com')
  })

  it('reserves quota before relaying to auth', async () => {
    const reserveSpy = vi.spyOn(rateLimitModule, 'reserveCaptchaFallbackQuota')
    const recordOrder: string[] = []
    reserveSpy.mockImplementation(async () => {
      recordOrder.push('reserve')
      return { limited: false }
    })
    fetchMock.mockImplementation(async () => {
      recordOrder.push('fetch')
      return new Response('{}', { status: 200 })
    })

    await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://console.capgo.app' },
      body: JSON.stringify({ email: 'user@example.com', purpose: 'magic_link' }),
    })

    expect(recordOrder).toEqual(['reserve', 'fetch'])
  })

  it('replaces recover redirect_to when origin is not the console webapp', async () => {
    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://console.capgo.app' },
      body: JSON.stringify({
        email: 'user@example.com',
        purpose: 'recover',
        redirect_to: 'https://evil.example/steal',
      }),
    })
    expect(response.status).toBe(200)

    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('redirect_to=')
    expect(decodeURIComponent(String(url))).toContain('https://console.capgo.app/forgot_password?step=2')
    expect(decodeURIComponent(String(url))).not.toContain('evil.example')
  })

  it('keeps recover redirect_to when origin matches the console webapp', async () => {
    const allowed = 'https://console.capgo.app/forgot_password?step=2&foo=bar'
    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://console.capgo.app' },
      body: JSON.stringify({
        email: 'user@example.com',
        purpose: 'recover',
        redirect_to: allowed,
      }),
    })
    expect(response.status).toBe(200)

    const [url] = fetchMock.mock.calls[0]
    expect(decodeURIComponent(String(url))).toContain(allowed)
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
