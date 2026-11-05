import { FunctionsFetchError, FunctionsHttpError } from '../src/services/consoleClient'
import { describe, expect, it } from 'vitest'
import {
  defaultRetriesForMethod,
  getCapgoApiErrorCode,
  isRetryableInvokeError,
  isRetryableStatus,
  retryBackoffMs,
} from '../src/services/capgoApi'

function httpError(body: unknown, status = 400) {
  return new FunctionsHttpError(new Response(body === null ? null : JSON.stringify(body), { status }))
}

describe('getCapgoApiErrorCode', () => {
  it.concurrent('returns 23505 from organization duplicate moreInfo messages', async () => {
    await expect(getCapgoApiErrorCode(httpError({
      error: 'cannot_create_org',
      message: 'Cannot create org',
      moreInfo: { error: 'duplicate key value violates unique constraint "orgs_name_key"' },
    }))).resolves.toBe('23505')
  })

  it.concurrent('returns top-level error codes when moreInfo is not a unique violation', async () => {
    await expect(getCapgoApiErrorCode(httpError({
      error: 'cannot_create_org',
      message: 'Cannot create org',
      moreInfo: { error: 'missing_org_super_admin_role' },
    }))).resolves.toBe('cannot_create_org')
  })
})

describe('retry policy', () => {
  it.concurrent.each([
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [504, true],
    [200, false],
    [201, false],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [409, false],
  ])('isRetryableStatus(%i) is %s', (status, expected) => {
    expect(isRetryableStatus(status)).toBe(expected)
  })

  it.concurrent.each([
    ['GET', 2],
    ['get', 2],
    ['HEAD', 2],
    ['OPTIONS', 2],
    ['POST', 0],
    ['put', 0],
    ['PATCH', 0],
    ['DELETE', 0],
  ])('defaultRetriesForMethod(%s) is %i (never auto-retry mutations)', (method, expected) => {
    expect(defaultRetriesForMethod(method)).toBe(expected)
  })

  it.concurrent.each([
    ['FunctionsFetchError', new FunctionsFetchError(new Error('boom')), true],
    ['fetch TypeError', new TypeError('Failed to fetch'), true],
    ['edge send failure', new Error('Failed to send a request to the Edge Function'), true],
    ['HTTP 503', httpError(null, 503), true],
    ['HTTP 400', httpError(null, 400), false],
    ['non-transient error', new Error('Not authenticated'), false],
    ['null', null, false],
    ['undefined', undefined, false],
  ])('isRetryableInvokeError(%s) is %s', (_label, error, expected) => {
    expect(isRetryableInvokeError(error)).toBe(expected)
  })

  it.concurrent.each([0, 1, 2, 3, 10])('retryBackoffMs(%i) grows exponentially within jittered bounds', (attempt) => {
    const exponential = Math.min(3000, 300 * 2 ** attempt)
    const delay = retryBackoffMs(attempt)
    expect(delay).toBeGreaterThanOrEqual(exponential / 2)
    expect(delay).toBeLessThanOrEqual(exponential)
  })
})
