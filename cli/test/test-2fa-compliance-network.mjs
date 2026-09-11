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

const HOST = { supaHost: 'https://fake.supabase.co', supaAnon: 'fake-anon' }

function assert2faAppRequest(url, init, apikey = 'ck_key', appId = 'com.example.app') {
  assert.match(url, /\/private\/cli\/check-2fa-app$/)
  assert.equal(init?.method ?? 'GET', 'POST')
  assert.equal(init?.headers?.capgkey, apikey)
  assert.deepEqual(JSON.parse(String(init?.body ?? '{}')), { app_id: appId })
}

function assert2faOrgRequest(url, init, apikey = 'ck_key', orgId = 'org_123') {
  assert.match(url, /\/private\/cli\/check-2fa-org$/)
  assert.equal(init?.method ?? 'GET', 'POST')
  assert.equal(init?.headers?.capgkey, apikey)
  assert.deepEqual(JSON.parse(String(init?.body ?? '{}')), { org_id: orgId })
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
assert.equal(isTransientNetworkError({ context: { status: 503 } }), true)
assert.equal(isTransientNetworkError({ context: { status: 429 } }), true)
assert.equal(isTransientNetworkError({ context: { status: 408 } }), true)
assert.equal(isTransientNetworkError({ context: { status: 404 } }), false)

const originalFetch = globalThis.fetch

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function installFetch(handler) {
  globalThis.fetch = async (input, init) => handler(String(input), init)
}

try {
  let networkAttempts = 0
  installFetch(async (url, init) => {
    if (url.includes('/private/cli/check-2fa-app')) {
      assert2faAppRequest(url, init)
      networkAttempts += 1
      throw new TypeError('fetch failed')
    }
    if (url.includes('/private/cli/check-2fa-org')) {
      assert2faOrgRequest(url, init)
      networkAttempts += 1
      throw new TypeError('fetch failed')
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  await check2FAComplianceForApp('ck_key', 'com.example.app', true, HOST)
  assert.equal(networkAttempts, TWO_FACTOR_PREFLIGHT_MAX_ATTEMPTS)

  let orgNetworkAttempts = 0
  installFetch(async (url, init) => {
    if (url.includes('/private/cli/check-2fa-org')) {
      assert2faOrgRequest(url, init)
      orgNetworkAttempts += 1
      throw new TypeError('fetch failed')
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  await check2FAAccessForOrg('ck_key', 'org_123', true, HOST)
  assert.equal(orgNetworkAttempts, TWO_FACTOR_PREFLIGHT_MAX_ATTEMPTS)

  let retryAttempts = 0
  installFetch(async (url, init) => {
    if (url.includes('/private/cli/check-2fa-app')) {
      assert2faAppRequest(url, init)
      retryAttempts += 1
      if (retryAttempts < 2)
        throw new TypeError('fetch failed')
      return json({ reject: false })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  await check2FAComplianceForApp('ck_key', 'com.example.app', true, HOST)
  assert.equal(retryAttempts, 2)

  installFetch(async (url, init) => {
    if (url.includes('/private/cli/check-2fa-app')) {
      assert2faAppRequest(url, init)
      return json({ reject: true })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  await assert.rejects(
    () => check2FAComplianceForApp('ck_key', 'com.example.app', true, HOST),
    (error) => {
      assert.equal(error instanceof Error, true)
      assert.equal(error.message, '2FA required for this organization')
      assert.equal(error instanceof TwoFactorComplianceNetworkError, false)
      return true
    },
  )

  installFetch(async (url, init) => {
    if (url.includes('/private/cli/check-2fa-app')) {
      assert2faAppRequest(url, init)
      return json({ error: 'permission denied for function reject_access_due_to_2fa_for_app' }, 403)
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  await assert.rejects(
    () => check2FAComplianceForApp('ck_key', 'com.example.app', true, HOST),
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
}
finally {
  globalThis.fetch = originalFetch
}
