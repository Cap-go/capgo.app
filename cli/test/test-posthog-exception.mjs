#!/usr/bin/env node
import assert from 'node:assert/strict'
import { cwd } from 'node:process'
import { Command } from 'commander'
import {
  capturePosthogException,
  getCommandPath,
  isExpectedUserError,
  shouldCapturePosthogException,
} from '../src/posthog.ts'

const originalFetch = globalThis.fetch
const originalEnv = {
  CAPGO_CLI_POSTHOG_API_HOST: process.env.CAPGO_CLI_POSTHOG_API_HOST,
  CAPGO_CLI_POSTHOG_API_KEY: process.env.CAPGO_CLI_POSTHOG_API_KEY,
  CAPGO_DISABLE_POSTHOG: process.env.CAPGO_DISABLE_POSTHOG,
  CAPGO_DISABLE_TELEMETRY: process.env.CAPGO_DISABLE_TELEMETRY,
  POSTHOG_API_HOST: process.env.POSTHOG_API_HOST,
  POSTHOG_API_KEY: process.env.POSTHOG_API_KEY,
}

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined)
      delete process.env[key]
    else
      process.env[key] = value
  }
}

try {
  console.log('Testing CLI PostHog exception capture...')

  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ init, url })
    return new Response('', { status: 200 })
  }

  process.env.CAPGO_CLI_POSTHOG_API_KEY = 'posthog-key'
  process.env.CAPGO_CLI_POSTHOG_API_HOST = 'https://eu.i.posthog.com/i/v0/e'
  delete process.env.CAPGO_DISABLE_POSTHOG
  delete process.env.CAPGO_DISABLE_TELEMETRY
  delete process.env.POSTHOG_API_KEY
  delete process.env.POSTHOG_API_HOST

  const error = new Error('boom')
  error.stack = `Error: boom\n    at runUpload (${cwd()}/src/index.ts:10:5)`

  const sent = await capturePosthogException({
    error,
    functionName: 'bundle upload',
    kind: 'unhandled_error',
    status: 1,
  })

  assert.equal(sent, true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://eu.i.posthog.com/i/v0/e/')

  const body = JSON.parse(requests[0].init.body)
  assert.equal(body.token, 'posthog-key')
  assert.equal(body.event, '$exception')
  assert.equal(body.properties.runtime, 'cli')
  assert.equal(body.properties.function_name, 'bundle upload')
  assert.equal(body.properties.error_kind, 'unhandled_error')
  assert.equal(body.properties.status, 1)
  assert.match(body.properties.distinct_id, /^cli:[^:]+:bundle upload$/)
  // Fingerprint must NOT include the CLI version, so one error stays one issue
  // across releases (the version is still reported via cli_version below).
  assert.match(body.properties.$exception_fingerprint, /^cli:bundle upload:unhandled_error:Error:runUpload:/)
  assert.equal(body.properties.cli_version, body.properties.distinct_id.split(':')[1])
  assert.equal(body.properties.$exception_list[0].type, 'Error')
  assert.equal(body.properties.$exception_list[0].value, 'boom')
  assert.equal(body.properties.$exception_list[0].mechanism.handled, true)
  assert.equal(body.properties.$exception_list[0].stacktrace.frames[0].filename, '<cwd>/src/index.ts')
  assert.equal(requests[0].init.signal instanceof AbortSignal, true)

  requests.length = 0
  const sensitiveError = new Error(`Cannot upload ${cwd()}/bundle.zip for test@example.com app com.example.secret --token abc123`)
  await capturePosthogException({
    error: sensitiveError,
    functionName: 'bundle upload',
    kind: 'unhandled_error',
    status: 1,
  })

  const sensitiveBody = JSON.parse(requests[0].init.body)
  assert.equal(
    sensitiveBody.properties.$exception_list[0].value,
    'Cannot upload <cwd>/<path> for <email> app <app_id> --token <redacted>',
  )

  requests.length = 0
  await capturePosthogException({
    error: undefined,
    functionName: 'bundle upload',
    kind: 'unhandled_error',
    status: 1,
  })

  const undefinedBody = JSON.parse(requests[0].init.body)
  assert.equal(undefinedBody.properties.$exception_list[0].value, 'undefined')

  requests.length = 0
  process.env.CAPGO_DISABLE_TELEMETRY = 'true'
  const disabledSent = await capturePosthogException({
    error,
    functionName: 'bundle upload',
    kind: 'unhandled_error',
    status: 1,
  })

  assert.equal(disabledSent, false)
  assert.equal(requests.length, 0)

  delete process.env.CAPGO_DISABLE_TELEMETRY
  process.env.CAPGO_CLI_POSTHOG_API_HOST = '://bad-host'
  const invalidHostSent = await capturePosthogException({
    error,
    functionName: 'bundle upload',
    kind: 'unhandled_error',
    status: 1,
  })

  assert.equal(invalidHostSent, false)
  assert.equal(requests.length, 0)

  const root = new Command('@capgo/cli')
  const bundle = root.command('bundle')
  const upload = bundle.command('upload')
  assert.equal(getCommandPath(upload), 'bundle upload')
  assert.equal(getCommandPath(root), 'unknown')

  assert.equal(shouldCapturePosthogException({ code: 'commander.helpDisplayed' }), false)
  assert.equal(shouldCapturePosthogException({ code: 'ENOENT' }), true)
  assert.equal(shouldCapturePosthogException(new Error('boom')), true)

  // Expected user errors must be skipped by exception capture (they are still
  // counted via trackCommandFailed at the call site).
  assert.equal(isExpectedUserError(new Error('Invalid API key or insufficient permissions.')), true)
  assert.equal(isExpectedUserError(new Error('invalid_apikey')), true)
  assert.equal(isExpectedUserError(new Error('no_key_provided')), true)
  assert.equal(isExpectedUserError(new Error('App com.example does not exist, run first `npx @capgo/cli app add com.example` to create it')), true)
  assert.equal(isExpectedUserError({ context: { status: 401 } }), true)
  assert.equal(isExpectedUserError({ status: 401 }), true)
  assert.equal(isExpectedUserError(new Error('Cannot get organization id for app id com.example')), false)
  assert.equal(isExpectedUserError(new Error('boom')), false)

  console.log('CLI PostHog exception capture tests passed')
}
finally {
  globalThis.fetch = originalFetch
  restoreEnv()
}
