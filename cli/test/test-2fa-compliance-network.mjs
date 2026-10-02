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
import { check2FAAccessForOrg } from '../src/utils.ts'

const httpOptions = {
  supaHost: 'http://localhost:54321',
  supaAnon: 'test-anon-key',
}

function makeSupabase() {
  return {
    supabaseUrl: httpOptions.supaHost,
    supabaseKey: httpOptions.supaAnon,
    rest: {
      headers: {
        get(name) {
          if (name.toLowerCase() === 'capgkey')
            return 'test-2fa-key'
          return null
        },
      },
    },
  }
}

const originalFetch = globalThis.fetch
let fetchAttempts = 0
let fetchMode = 'ok'
let succeedAfterAttempts = 1

globalThis.fetch = async (input) => {
  const url = String(input)
  if (!url.includes('/private/cli/2fa/'))
    return originalFetch(input)

  fetchAttempts += 1

  if (fetchMode === 'network')
    throw new TypeError('fetch failed')

  if (fetchMode === 'retry-then-ok') {
    if (fetchAttempts < succeedAfterAttempts)
      throw new TypeError('fetch failed')
    return new Response(JSON.stringify({ reject: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (fetchMode === 'reject') {
    return new Response(JSON.stringify({ reject: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (fetchMode === 'permission-denied') {
    return new Response(JSON.stringify({ error: 'permission denied for function reject_access_due_to_2fa_for_app' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ reject: false }), {
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
await check2FAComplianceForApp(makeSupabase(), 'com.example.app', true, httpOptions)
assert.equal(fetchAttempts, TWO_FACTOR_PREFLIGHT_MAX_ATTEMPTS)

resetFetch('network')
await check2FAAccessForOrg(makeSupabase(), 'org_123', true, httpOptions)
assert.equal(fetchAttempts, TWO_FACTOR_PREFLIGHT_MAX_ATTEMPTS)

resetFetch('retry-then-ok', 2)
await check2FAComplianceForApp(makeSupabase(), 'com.example.app', true, httpOptions)
assert.equal(fetchAttempts, 2)

resetFetch('reject')
await assert.rejects(
  () => check2FAComplianceForApp(makeSupabase(), 'com.example.app', true, httpOptions),
  (error) => {
    assert.equal(error instanceof Error, true)
    assert.equal(error.message, '2FA required for this organization')
    assert.equal(error instanceof TwoFactorComplianceNetworkError, false)
    return true
  },
)

resetFetch('permission-denied')
await assert.rejects(
  () => check2FAComplianceForApp(makeSupabase(), 'com.example.app', true, httpOptions),
  (error) => {
    assert.equal(error instanceof Error, true)
    assert.equal(error instanceof TwoFactorComplianceNetworkError, false)
    assert.match(error.message, /Cannot check 2FA compliance/)
    assert.equal(shouldCapturePosthogException(error), true)
    return true
  },
)

assert.equal(shouldCapturePosthogException(new TwoFactorComplianceNetworkError()), true)
assert.equal(new TwoFactorComplianceNetworkError().message, TWO_FACTOR_COMPLIANCE_NETWORK_MESSAGE)
assert.equal(new TwoFactorComplianceNetworkError() instanceof CliUserError, false)

globalThis.fetch = originalFetch

console.log('2FA compliance network failure tests passed')
