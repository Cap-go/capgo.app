#!/usr/bin/env node
import assert from 'node:assert/strict'
import { categorizeCliError } from '../src/analytics/error-category.ts'
import { CapgoApiHttpError } from '../src/api/http-error.ts'
import {
  CAPGO_API_RETRY_MAX_ATTEMPTS,
  getCapgoApiRetryDelayMs,
  invokeCapgoCliApiResultWithRetry,
  isRetryableCapgoApiError,
} from '../src/shared/retryable-capgo-api-error.ts'

function make503Error(body, headers = {}) {
  const response = new Response(JSON.stringify(body), {
    status: 503,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
  return new CapgoApiHttpError(response)
}

const databaseUnavailable = make503Error({
  error: 'database_unavailable',
  message: 'Database temporarily unavailable',
  moreInfo: { retryAfterSeconds: 2 },
}, { 'Retry-After': '2' })

assert.equal(categorizeCliError(databaseUnavailable), 'server_error')
assert.equal(await isRetryableCapgoApiError(databaseUnavailable), true)
assert.equal(await getCapgoApiRetryDelayMs(databaseUnavailable, 0), 2000)

const immediateRetry = make503Error({
  error: 'database_unavailable',
  moreInfo: { retryAfterSeconds: 0 },
})
assert.equal(await getCapgoApiRetryDelayMs(immediateRetry, 0), 0)
const immediateHeaderRetry = make503Error(
  { error: 'database_unavailable' },
  { 'Retry-After': '0' },
)
assert.equal(await getCapgoApiRetryDelayMs(immediateHeaderRetry, 0), 0)

const generic503 = make503Error({ error: 'translation_unavailable' })
assert.equal(await isRetryableCapgoApiError(generic503), false)

let calls = 0
const result = await invokeCapgoCliApiResultWithRetry(async () => {
  calls += 1
  if (calls < 2)
    return { data: null, error: databaseUnavailable }
  return { data: { ok: true }, error: null }
}, async () => {})

assert.equal(calls, 2)
assert.deepEqual(result.data, { ok: true })

calls = 0
const exhausted = await invokeCapgoCliApiResultWithRetry(async () => {
  calls += 1
  return { data: null, error: databaseUnavailable }
}, async () => {})
assert.equal(calls, CAPGO_API_RETRY_MAX_ATTEMPTS)
assert.ok(exhausted.error)

calls = 0
const networkOnly = await invokeCapgoCliApiResultWithRetry(async () => {
  calls += 1
  return { data: null, error: new TypeError('fetch failed') }
}, async () => {}, { retryTransientNetwork: false })
assert.equal(calls, 1)
assert.ok(networkOnly.error)

console.log('retryable Capgo API error tests passed')
