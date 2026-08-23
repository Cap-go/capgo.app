#!/usr/bin/env node
import assert from 'node:assert/strict'
import { check2FAComplianceForApp } from '../src/api/app.ts'
import { shouldCapturePosthogException } from '../src/posthog.ts'
import { CliUserError } from '../src/shared/cli-user-error.ts'
import { isTransientNetworkError } from '../src/shared/network-error.ts'
import { TWO_FACTOR_COMPLIANCE_NETWORK_MESSAGE } from '../src/shared/two-factor-compliance.ts'
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

assert.equal(isTransientNetworkError(new Error('TypeError: fetch failed')), true)
assert.equal(isTransientNetworkError({ message: 'ECONNREFUSED' }), true)
assert.equal(isTransientNetworkError(new Error('ETIMEDOUT')), true)
assert.equal(isTransientNetworkError(new Error('DNS policy misconfiguration for org')), false)
assert.equal(isTransientNetworkError(new Error('permission denied for function')), false)

const networkSupabase = makeSupabaseWithRpcError('TypeError: fetch failed')

await assert.rejects(
  () => check2FAComplianceForApp(networkSupabase, 'com.example.app', true),
  (error) => {
    assert.equal(error instanceof CliUserError, true)
    assert.equal(error.message, TWO_FACTOR_COMPLIANCE_NETWORK_MESSAGE)
    assert.equal(shouldCapturePosthogException(error), false)
    return true
  },
)

await assert.rejects(
  () => check2FAAccessForOrg(networkSupabase, 'org_123', true),
  (error) => {
    assert.equal(error instanceof CliUserError, true)
    assert.equal(error.message, TWO_FACTOR_COMPLIANCE_NETWORK_MESSAGE)
    assert.equal(shouldCapturePosthogException(error), false)
    return true
  },
)

const appErrorSupabase = makeSupabaseWithRpcError('permission denied for function reject_access_due_to_2fa_for_app')

await assert.rejects(
  () => check2FAComplianceForApp(appErrorSupabase, 'com.example.app', true),
  (error) => {
    assert.equal(error instanceof Error, true)
    assert.equal(error instanceof CliUserError, false)
    assert.match(error.message, /Cannot check 2FA compliance/)
    assert.equal(shouldCapturePosthogException(error), true)
    return true
  },
)

console.log('2FA compliance network failure tests passed')
