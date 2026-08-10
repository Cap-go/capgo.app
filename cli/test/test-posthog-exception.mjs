#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cwd } from 'node:process'
import { Command } from 'commander'
import { IncompatibleBundleError } from '../src/bundle/upload.ts'
import {
  capturePosthogException,
  getCommandPath,
  getInstallId,
  isExpectedUserError,
  shouldCapturePosthogException,
} from '../src/posthog.ts'
import { CliUserError } from '../src/shared/cli-user-error.ts'

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

// Resolve the install id against a throwaway config directory. This seeds the
// module cache, so the later capturePosthogException calls reuse it without
// touching the real home directory.
const installIdDir = mkdtempSync(join(tmpdir(), 'capgo-posthog-'))
const installId = getInstallId(installIdDir)

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
  // distinct_id must be the anonymous, stable per-install id (a UUID) — never
  // the CLI version or the command name, so "users affected" counts real installs.
  assert.equal(body.properties.distinct_id, installId)
  assert.match(body.properties.distinct_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  // The id is generated once and persisted in the CLI config directory.
  const installIdPath = join(installIdDir, 'install-id')
  assert.equal(existsSync(installIdPath), true)
  assert.equal(readFileSync(installIdPath, 'utf8').trim(), installId)
  // Fingerprint must NOT include the CLI version, the top-frame symbol, or the
  // top-frame filename, so the same bug stays one error-tracking issue across
  // releases and across install locations (npx cache hash, bunx, pnpm, sandbox).
  // Version is still reported via cli_version.
  assert.equal(body.properties.$exception_fingerprint, 'bundle upload:unhandled_error:Error:1')
  assert.doesNotMatch(body.properties.$exception_fingerprint, /cli:/)
  assert.doesNotMatch(body.properties.$exception_fingerprint, /runUpload/)
  assert.doesNotMatch(body.properties.$exception_fingerprint, /index\.ts/)
  assert.equal(typeof body.properties.cli_version, 'string')
  assert.notEqual(body.properties.cli_version, '')
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
  // The install id is stable across captures.
  assert.equal(body.properties.distinct_id, sensitiveBody.properties.distinct_id)

  // A two-segment app id (com.phantom) must be redacted too, not only ids with
  // three or more segments — the raw id must never reach the error title.
  requests.length = 0
  const twoSegmentError = new Error('App com.phantom already exists')
  await capturePosthogException({
    error: twoSegmentError,
    functionName: 'app add',
    kind: 'unhandled_error',
    status: 1,
  })

  const twoSegmentBody = JSON.parse(requests[0].init.body)
  assert.equal(twoSegmentBody.properties.$exception_list[0].value, 'App <app_id> already exists')
  assert.equal(twoSegmentBody.properties.$exception_list[0].value.includes('com.phantom'), false)

  // Two occurrences of the SAME logical error but with different minified top
  // frames (as different builds / call sites produce) must share one fingerprint.
  requests.length = 0
  const minifiedA = new Error('boom')
  minifiedA.stack = `Error: boom\n    at T0 (${cwd()}/dist/index.js:1:20)`
  const minifiedB = new Error('boom')
  minifiedB.stack = `Error: boom\n    at CDA (${cwd()}/dist/chunk-2.js:9:3)`
  for (const minified of [minifiedA, minifiedB]) {
    await capturePosthogException({
      error: minified,
      functionName: 'bundle upload',
      kind: 'unhandled_error',
      status: 1,
    })
  }
  assert.equal(requests.length, 2)
  const [fpA, fpB] = requests.map(r => JSON.parse(r.init.body).properties.$exception_fingerprint)
  assert.equal(fpA, fpB)
  assert.equal(fpA, 'bundle upload:unhandled_error:Error:1')

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

  // Expected user-facing CLI failures must never open an error tracking issue,
  // regardless of the (dynamic) channel context attached to them.
  assert.equal(shouldCapturePosthogException(new CliUserError('Channel does not have a bundle linked', { appId: 'com.example.app', channel: 'production' })), false)
  assert.equal(shouldCapturePosthogException(new CliUserError('Missing API key')), false)
  // `findSavedKey` throws this as a CliUserError when nobody ran `capgo login`;
  // it must be skipped (a plain Error with this text would have leaked through).
  assert.equal(shouldCapturePosthogException(new CliUserError('Cannot find API key in local folder or global, please login first with `capgo login`')), false)
  // `uploadFail` now throws CliUserError, so a duplicate-version upload — a normal
  // `bundle upload` outcome — is filtered out of error tracking by type.
  assert.equal(shouldCapturePosthogException(new CliUserError('Version 1.2.3 already exists')), false)
  // The `--fail-on-incompatible` abort is a state the user asked for, not a
  // crash, so it must never open an error tracking issue either.
  assert.equal(new IncompatibleBundleError('Upload aborted: bundle is incompatible') instanceof CliUserError, true)
  assert.equal(shouldCapturePosthogException(new IncompatibleBundleError('Upload aborted: bundle is incompatible')), false)
  // A user-initiated cancel (Ctrl+C / Escape at an interactive prompt) is a
  // deliberate abort, not a crash — the cancel sites throw CliUserError so it
  // never opens an error tracking issue.
  assert.equal(shouldCapturePosthogException(new CliUserError('Login cancelled')), false)
  assert.equal(shouldCapturePosthogException(new CliUserError('Upload cancelled by user')), false)
  // `resolveUserIdFromApiKey` throws a bad-key failure as CliUserError, so a
  // later reword of the message can no longer break the filter by substring.
  assert.equal(shouldCapturePosthogException(new CliUserError('Capgo authentication failed: invalid Capgo API key or insufficient Capgo permissions.')), false)
  // `checkAppExistsAndHasPermissionOrgErr` throws the RBAC failure as
  // CliUserError; the app id lives in context (the permission key is a bounded
  // enum and stays in the message), so every app maps to one issue per
  // permission instead of one issue per app.
  assert.equal(shouldCapturePosthogException(new CliUserError('Insufficient permissions for app. Required RBAC permission for this action: app.write.', { appId: 'com.example.app' })), false)
  assert.equal(
    new CliUserError('Insufficient permissions for app. Required RBAC permission for this action: channel.delete.', { appId: 'com.a' }).message,
    new CliUserError('Insufficient permissions for app. Required RBAC permission for this action: channel.delete.', { appId: 'com.b' }).message,
  )
  // Two failures on different channels must be treated identically (one issue,
  // not one per channel), since the channel name lives in context, not the message.
  assert.equal(
    new CliUserError('Channel does not have a bundle linked', { channel: 'production' }).message,
    new CliUserError('Channel does not have a bundle linked', { channel: 'canary' }).message,
  )

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
  assert.equal(shouldCapturePosthogException(new Error('invalid_apikey')), false)
  assert.equal(shouldCapturePosthogException({ context: { status: 401 } }), false)
  assert.equal(shouldCapturePosthogException(new Error('Cannot get organization id for app id com.example')), true)

  console.log('CLI PostHog exception capture tests passed')
}
finally {
  globalThis.fetch = originalFetch
  restoreEnv()
}
