#!/usr/bin/env node
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

function makeSupabaseWithRpcError(message) {
  return {
    rpc(name) {
      if (name === 'reject_access_due_to_2fa_for_app' || name === 'reject_access_due_to_2fa_for_org')
        return Promise.resolve({ data: null, error: { message } })
      throw new Error(`Unexpected RPC call: ${name}`)
    },
  }
}

function makeSupabaseWithRetryableNetworkError(succeedAfterAttempts) {
  let attempts = 0
  return {
    rpc(name) {
      if (name === 'reject_access_due_to_2fa_for_app' || name === 'reject_access_due_to_2fa_for_org') {
        attempts += 1
        if (attempts < succeedAfterAttempts)
          return Promise.resolve({ data: null, error: { message: 'TypeError: fetch failed' } })
        return Promise.resolve({ data: false, error: null })
      }
      throw new Error(`Unexpected RPC call: ${name}`)
    },
    get attempts() {
      return attempts
    },
  }
}

function makeSupabaseWithPersistentNetworkError() {
  let attempts = 0
  return {
    rpc(name) {
      if (name === 'reject_access_due_to_2fa_for_app' || name === 'reject_access_due_to_2fa_for_org') {
        attempts += 1
        return Promise.resolve({ data: null, error: { message: 'TypeError: fetch failed' } })
      }
      throw new Error(`Unexpected RPC call: ${name}`)
    },
    get attempts() {
      return attempts
    },
  }
}

function makeSupabaseWithRejectResult() {
  return {
    rpc(name) {
      if (name === 'reject_access_due_to_2fa_for_app' || name === 'reject_access_due_to_2fa_for_org')
        return Promise.resolve({ data: true, error: null })
      throw new Error(`Unexpected RPC call: ${name}`)
    },
  }
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

const networkSupabase = makeSupabaseWithPersistentNetworkError()

await check2FAComplianceForApp(networkSupabase, 'com.example.app', true)
assert.equal(networkSupabase.attempts, TWO_FACTOR_PREFLIGHT_MAX_ATTEMPTS)

const orgNetworkSupabase = makeSupabaseWithPersistentNetworkError()
await check2FAAccessForOrg(orgNetworkSupabase, 'org_123', true)
assert.equal(orgNetworkSupabase.attempts, TWO_FACTOR_PREFLIGHT_MAX_ATTEMPTS)

const retrySupabase = makeSupabaseWithRetryableNetworkError(2)
await check2FAComplianceForApp(retrySupabase, 'com.example.app', true)
assert.equal(retrySupabase.attempts, 2)

await assert.rejects(
  () => check2FAComplianceForApp(makeSupabaseWithRejectResult(), 'com.example.app', true),
  (error) => {
    assert.equal(error instanceof Error, true)
    assert.equal(error.message, '2FA required for this organization')
    assert.equal(error instanceof TwoFactorComplianceNetworkError, false)
    return true
  },
)

const appErrorSupabase = makeSupabaseWithRpcError('permission denied for function reject_access_due_to_2fa_for_app')

await assert.rejects(
  () => check2FAComplianceForApp(appErrorSupabase, 'com.example.app', true),
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

console.log('2FA compliance network failure tests passed')
