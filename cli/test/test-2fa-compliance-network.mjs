#!/usr/bin/env node
process.env.CAPGO_DISABLE_POSTHOG = '1'
import assert from 'node:assert/strict'
import { check2FAComplianceForApp } from '../src/api/app.ts'
import { shouldCapturePosthogException } from '../src/posthog.ts'
import { CliUserError } from '../src/shared/cli-user-error.ts'
import { isTransientNetworkError } from '../src/shared/network-error.ts'
import {
  TWO_FACTOR_COMPLIANCE_NETWORK_MESSAGE,
  TWO_FACTOR_PREFLIGHT_MAX_ATTEMPTS,
  TwoFactorComplianceNetworkError,
} from '../src/shared/two-factor-compliance.ts'
import { check2FAAccessForOrg } from '../src/api/preflight.ts'

const apiHost = 'http://localhost:54321/functions/v1'

function makeClient() {
  return {
    apikey: 'test-2fa-key',
    apiHost,
    filesHost: apiHost,
  }
}

const okBody = JSON.stringify({ user_id: 'user-1', org_id: 'org_123', app_id: null, trial_days_left: null, warnings: [] })

const originalFetch = globalThis.fetch
let fetchAttempts = 0
let fetchMode = 'ok'
let succeedAfterAttempts = 1

globalThis.fetch = async (input) => {
  const url = String(input)
  if (!url.includes('/private/cli/preflight'))
    return originalFetch(input)

  fetchAttempts += 1

  if (fetchMode === 'network')
    throw new TypeError('fetch failed')

  if (fetchMode === 'retry-then-ok') {
    if (fetchAttempts < succeedAfterAttempts)
      throw new TypeError('fetch failed')
    return new Response(okBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (fetchMode === 'reject') {
    return new Response(JSON.stringify({ error: '2fa_required', message: 'Two-factor authentication is required by this organization' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (fetchMode === 'permission-denied') {
    return new Response(JSON.stringify({ error: 'cannot_check_2fa', message: 'Cannot check app 2FA access' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(okBody, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function resetFetch(mode, succeedAfter = 1) {
  fetchAttempts = 0
  fetchMode = mode
  succeedAfterAttempts = succeedAfter
}

assert.equal(isTransientNetworkError(new Error('TypeError: fetch failed')), true)
assert.equal(isTransientNetworkError({ message: 'ECONNREFUSED' }), true)
assert.equal(isTransientNetworkError(new Error('ETIMEDOUT')), true)
assert.equal(isTransientNetworkError(new Error('DNS policy misconfiguration for org')), false)
assert.equal(isTransientNetworkError(new Error('permission denied for function')), false)

const nestedCause = new Error('TypeError: fetch failed', {
  cause: new Error('connect ECONNRESET'),
})
assert.equal(isTransientNetworkError(nestedCause), true)

resetFetch('network')
await check2FAComplianceForApp(makeClient(), 'com.example.app', true)
assert.equal(fetchAttempts, TWO_FACTOR_PREFLIGHT_MAX_ATTEMPTS)

resetFetch('network')
await check2FAAccessForOrg(makeClient(), 'org_123', true)
assert.equal(fetchAttempts, TWO_FACTOR_PREFLIGHT_MAX_ATTEMPTS)

resetFetch('retry-then-ok', 2)
await check2FAComplianceForApp(makeClient(), 'com.example.app', true)
assert.equal(fetchAttempts, 2)

resetFetch('reject')
await assert.rejects(
  () => check2FAComplianceForApp(makeClient(), 'com.example.app', true),
  (error) => {
    assert.equal(error instanceof Error, true)
    assert.equal(error.message, '2FA required for this organization')
    assert.equal(error instanceof TwoFactorComplianceNetworkError, false)
    return true
  },
)

resetFetch('permission-denied')
await assert.rejects(
  () => check2FAComplianceForApp(makeClient(), 'com.example.app', true),
  (error) => {
    assert.equal(error instanceof Error, true)
    assert.equal(error instanceof TwoFactorComplianceNetworkError, false)
    assert.match(error.message, /Cannot verify access/)
    assert.equal(shouldCapturePosthogException(error), true)
    return true
  },
)

assert.equal(shouldCapturePosthogException(new TwoFactorComplianceNetworkError()), true)
assert.equal(new TwoFactorComplianceNetworkError().message, TWO_FACTOR_COMPLIANCE_NETWORK_MESSAGE)
assert.equal(new TwoFactorComplianceNetworkError() instanceof CliUserError, false)

globalThis.fetch = originalFetch

console.log('2FA compliance network failure tests passed')
