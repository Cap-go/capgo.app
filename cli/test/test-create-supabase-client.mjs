#!/usr/bin/env node

import assert from 'node:assert/strict'
import { chdir, cwd } from 'node:process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CAPGO_SERVER_CONFIG_MISSING_MESSAGE, createSupabaseClient, defaultApiHost, hostOptionsFromSupabase, resolveCliHostOptions } from '../src/utils.ts'
import { CliUserError } from '../src/shared/cli-user-error.ts'
import { shouldCapturePosthogException } from '../src/posthog.ts'

const originalFetch = globalThis.fetch
const originalCwd = cwd()

const isolatedDir = mkdtempSync(join(tmpdir(), 'capgo-create-supabase-client-'))

async function assertMissingConfig(fetchImpl, expectedContext, label) {
  globalThis.fetch = fetchImpl
  const controller = new AbortController()
  let thrown
  try {
    await createSupabaseClient('test-api-key', undefined, undefined, true, false, controller.signal)
    assert.fail(`expected createSupabaseClient to throw (${label})`)
  }
  catch (error) {
    thrown = error
  }

  assert.equal(thrown instanceof CliUserError, true, label)
  assert.equal(thrown.message, CAPGO_SERVER_CONFIG_MISSING_MESSAGE, label)
  assert.equal(thrown.context?.missingSupaHost, expectedContext.missingSupaHost, label)
  assert.equal(thrown.context?.missingSupaKey, expectedContext.missingSupaKey, label)
  assert.equal(shouldCapturePosthogException(thrown), false, label)
}

function remoteConfigResponse(body) {
  return async (url) => {
    if (String(url) === `${defaultApiHost}/private/config`) {
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
}

try {
  chdir(isolatedDir)

  await assertMissingConfig(
    async () => {
      throw new Error('network unavailable')
    },
    { missingSupaHost: true, missingSupaKey: true },
    'both missing after remote config fallback',
  )

  await assertMissingConfig(
    remoteConfigResponse({
      host: 'https://capgo.app',
      hostWeb: 'https://console.capgo.app',
      hostFilesApi: 'https://files.capgo.app',
      hostApi: defaultApiHost,
      supaHost: 'https://db.example.com',
    }),
    { missingSupaHost: false, missingSupaKey: true },
    'remote config missing supaKey',
  )

  await assertMissingConfig(
    remoteConfigResponse({
      host: 'https://capgo.app',
      hostWeb: 'https://console.capgo.app',
      hostFilesApi: 'https://files.capgo.app',
      hostApi: defaultApiHost,
      supaKey: 'anon-key',
    }),
    { missingSupaHost: true, missingSupaKey: false },
    'remote config missing supaHost',
  )

  assert.equal(
    new CliUserError(CAPGO_SERVER_CONFIG_MISSING_MESSAGE, { missingSupaHost: true }).message,
    new CliUserError(CAPGO_SERVER_CONFIG_MISSING_MESSAGE, { missingSupaHost: false, missingSupaKey: true }).message,
  )

  const selfHostClient = {
    supabaseUrl: 'https://selfhost.example.com',
    supabaseKey: 'anon-key',
  }
  assert.deepEqual(hostOptionsFromSupabase(selfHostClient), {
    supaHost: 'https://selfhost.example.com',
    supaAnon: 'anon-key',
  })
  assert.equal(hostOptionsFromSupabase({
    supabaseUrl: 'https://sb.capgo.app',
    supabaseKey: 'anon-key',
  }), undefined)
  assert.deepEqual(
    resolveCliHostOptions(selfHostClient),
    { supaHost: 'https://selfhost.example.com', supaAnon: 'anon-key' },
  )
  assert.deepEqual(
    resolveCliHostOptions(selfHostClient, { supaHost: 'https://explicit.example.com', supaAnon: 'explicit-key' }),
    { supaHost: 'https://explicit.example.com', supaAnon: 'explicit-key' },
  )

  console.log('createSupabaseClient missing-config tests passed')
}
finally {
  chdir(originalCwd)
  globalThis.fetch = originalFetch
  rmSync(isolatedDir, { recursive: true, force: true })
}
