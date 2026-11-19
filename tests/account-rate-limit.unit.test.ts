import type { Context } from 'hono'
import { Hono } from 'hono/tiny'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app as validatePasswordComplianceApp } from '../supabase/functions/_backend/private/validate_password_compliance.ts'
import {
  clearFailedAccountAuth,
  isAccountRateLimited,
  isIPRateLimited,
  normalizeRateLimitAccountIdentifier,
  recordFailedAccountAuth,
} from '../supabase/functions/_backend/utils/rate_limit.ts'

type CacheStore = Map<string, Response>

let previousCaches: typeof globalThis.caches | undefined

function installMemoryCache() {
  const store: CacheStore = new Map()
  const cache = {
    match: async (request: Request) => store.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => {
      store.set(request.url, response.clone())
    },
  }

  previousCaches = globalThis.caches
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      open: async () => cache,
    },
  })

  return store
}

async function withContext<T>(handler: (c: Context) => Promise<T>, ip: string) {
  const app = new Hono()
  app.get('/', async (c) => {
    c.set('requestId', 'account-rate-limit-test')
    const result = await handler(c)
    return c.json(result ?? { ok: true })
  })

  const response = await app.request('http://rate-limit.test/', {
    headers: {
      'cf-connecting-ip': ip,
    },
  })

  return await response.json<T>()
}

describe('account failed-auth rate limiting', () => {
  beforeEach(() => {
    installMemoryCache()
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: previousCaches,
    })
  })

  it('normalizes account identifiers before hashing', () => {
    expect(normalizeRateLimitAccountIdentifier('  Victim@Example.COM  ')).toBe('victim@example.com')
    expect(normalizeRateLimitAccountIdentifier('Local+tag@Example.com')).toBe('local@example.com')
    expect(normalizeRateLimitAccountIdentifier('john.doe+promo@gmail.com')).toBe('johndoe@gmail.com')
    expect(normalizeRateLimitAccountIdentifier('john.doe@googlemail.com')).toBe('johndoe@gmail.com')
  })

  it('limits by account across different client IPs', async () => {
    for (let attempt = 0; attempt < 19; attempt++) {
      await withContext(c => recordFailedAccountAuth(c, 'Victim@Example.COM'), `198.51.100.${attempt + 1}`)
    }

    const beforeLimit = await withContext(
      c => isAccountRateLimited(c, 'victim@example.com'),
      '203.0.113.2',
    )
    expect(beforeLimit.limited).toBe(false)

    await withContext(c => recordFailedAccountAuth(c, 'victim@example.com'), '203.0.113.3')

    const afterSecondAttempt = await withContext(
      c => isAccountRateLimited(c, 'VICTIM@example.com'),
      '203.0.113.4',
    )
    expect(afterSecondAttempt.limited).toBe(true)
  })

  it('clears the account limiter after successful verification', async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      await withContext(c => recordFailedAccountAuth(c, 'clear-me@example.com'), `198.51.100.${attempt + 1}`)
    }

    const beforeClear = await withContext(
      c => isAccountRateLimited(c, 'clear-me@example.com'),
      '198.51.100.3',
    )
    expect(beforeClear.limited).toBe(true)

    await withContext(c => clearFailedAccountAuth(c, 'clear-me@example.com'), '198.51.100.4')

    const afterClear = await withContext(
      c => isAccountRateLimited(c, 'clear-me@example.com'),
      '198.51.100.5',
    )
    expect(afterClear.limited).toBe(false)
  })

  it('blocks password compliance verification by account across different client IPs', async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      await withContext(c => recordFailedAccountAuth(c, 'password-policy@example.com'), `198.51.100.${attempt + 1}`)
    }

    const app = new Hono()
    app.route('/validate_password_compliance', validatePasswordComplianceApp)
    app.onError((error, _c) => {
      const errorDetails = error as unknown as {
        cause?: { error?: string, moreInfo?: { reason?: string } }
        status?: unknown
      }
      const status = typeof errorDetails.status === 'number' ? errorDetails.status : 500
      const cause = errorDetails.cause
      return new Response(JSON.stringify({ error: cause?.error, reason: cause?.moreInfo?.reason }), {
        headers: { 'Content-Type': 'application/json' },
        status,
      })
    })

    const response = await app.request('http://rate-limit.test/validate_password_compliance', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'cf-connecting-ip': '203.0.113.20',
      },
      body: JSON.stringify({
        email: 'password-policy@example.com',
        password: 'WrongPassword123!',
        org_id: '00000000-0000-4000-8000-000000000000',
      }),
    })

    expect(response.status).toBe(429)
    const responseBody = await response.json() as { error?: string, reason?: string }
    expect(responseBody.error).toBe('too_many_requests')
    expect(responseBody.reason).toBe('too_many_failed_account_auth_attempts')

    const freshIpStatus = await withContext(
      c => isIPRateLimited(c),
      '203.0.113.20',
    )
    expect(freshIpStatus.limited).toBe(false)
  })
})
