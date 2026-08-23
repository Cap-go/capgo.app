#!/usr/bin/env node

import assert from 'node:assert/strict'
import { chdir, cwd } from 'node:process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CAPGO_SERVER_CONFIG_MISSING_MESSAGE, createSupabaseClient } from '../src/utils.ts'
import { CliUserError } from '../src/shared/cli-user-error.ts'
import { shouldCapturePosthogException } from '../src/posthog.ts'

const originalFetch = globalThis.fetch
const originalCwd = cwd()

const isolatedDir = mkdtempSync(join(tmpdir(), 'capgo-create-supabase-client-'))

try {
  chdir(isolatedDir)
  globalThis.fetch = async () => {
    throw new Error('network unavailable')
  }

  const controller = new AbortController()
  let thrown
  try {
    await createSupabaseClient('test-api-key', undefined, undefined, true, false, controller.signal)
    assert.fail('expected createSupabaseClient to throw')
  }
  catch (error) {
    thrown = error
  }

  assert.equal(thrown instanceof CliUserError, true)
  assert.equal(thrown.message, CAPGO_SERVER_CONFIG_MISSING_MESSAGE)
  assert.equal(
    new CliUserError(CAPGO_SERVER_CONFIG_MISSING_MESSAGE, { missingSupaHost: true }).message,
    new CliUserError(CAPGO_SERVER_CONFIG_MISSING_MESSAGE, { missingSupaHost: false, missingSupaKey: true }).message,
  )
  assert.equal(thrown.context?.missingSupaHost, true)
  assert.equal(thrown.context?.missingSupaKey, true)
  assert.equal(shouldCapturePosthogException(thrown), false)

  console.log('createSupabaseClient missing-config tests passed')
}
finally {
  chdir(originalCwd)
  globalThis.fetch = originalFetch
  rmSync(isolatedDir, { recursive: true, force: true })
}
