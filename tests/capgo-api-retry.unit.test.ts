import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import {
  defaultRetriesForMethod,
  isRetryableInvokeError,
  isRetryableStatus,
  retryBackoffMs,
} from '../src/services/capgoApi'

describe('isRetryableStatus', () => {
  it('retries transient backend statuses', () => {
    for (const status of [429, 500, 502, 503, 504])
      expect(isRetryableStatus(status)).toBe(true)
  })

  it('does not retry success or client errors', () => {
    for (const status of [200, 201, 400, 401, 403, 404, 409])
      expect(isRetryableStatus(status)).toBe(false)
  })
})

describe('defaultRetriesForMethod', () => {
  it('retries idempotent methods only', () => {
    for (const method of ['GET', 'get', 'HEAD', 'OPTIONS'])
      expect(defaultRetriesForMethod(method)).toBe(2)
  })

  it('never auto-retries mutations', () => {
    for (const method of ['POST', 'put', 'PATCH', 'DELETE'])
      expect(defaultRetriesForMethod(method)).toBe(0)
  })
})

describe('isRetryableInvokeError', () => {
  it('retries network-level failures', () => {
    expect(isRetryableInvokeError(new FunctionsFetchError(new Error('boom')))).toBe(true)
    expect(isRetryableInvokeError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isRetryableInvokeError(new Error('Failed to send a request to the Edge Function'))).toBe(true)
  })

  it('retries 5xx/429 HTTP errors but not 4xx business errors', () => {
    expect(isRetryableInvokeError(new FunctionsHttpError(new Response(null, { status: 503 })))).toBe(true)
    expect(isRetryableInvokeError(new FunctionsHttpError(new Response(null, { status: 400 })))).toBe(false)
  })

  it('does not retry non-transient errors', () => {
    expect(isRetryableInvokeError(new Error('Not authenticated'))).toBe(false)
    expect(isRetryableInvokeError(null)).toBe(false)
    expect(isRetryableInvokeError(undefined)).toBe(false)
  })
})

describe('retryBackoffMs', () => {
  it('grows exponentially and stays within jittered bounds', () => {
    for (const attempt of [0, 1, 2, 3, 10]) {
      const exponential = Math.min(3000, 300 * 2 ** attempt)
      const delay = retryBackoffMs(attempt)
      expect(delay).toBeGreaterThanOrEqual(exponential / 2)
      expect(delay).toBeLessThanOrEqual(exponential)
    }
  })
})
