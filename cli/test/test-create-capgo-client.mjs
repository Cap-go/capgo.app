#!/usr/bin/env node

import assert from 'node:assert/strict'
import { chdir, cwd } from 'node:process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCapgoClient, defaultApiHost, defaultFileHost, normalizeCapgoHostOptions } from '../src/utils.ts'
import { CliUserError } from '../src/shared/cli-user-error.ts'

const originalFetch = globalThis.fetch
const originalCwd = cwd()

const isolatedDir = mkdtempSync(join(tmpdir(), 'capgo-create-capgo-client-'))

try {
  chdir(isolatedDir)
  // The Capgo API is the only backend: an unreachable config endpoint must not block client creation.
  globalThis.fetch = async () => {
    throw new Error('network unavailable')
  }

  const cloud = await createCapgoClient('test-api-key', undefined, true)
  assert.deepEqual(cloud, { apikey: 'test-api-key', apiHost: defaultApiHost, filesHost: defaultFileHost })
  assert.equal('supaHost' in cloud || 'supaAnon' in cloud, false, 'no Supabase coordinates in the client')

  const selfHost = await createCapgoClient('test-api-key', 'https://self.example.com/functions/v1/', true)
  assert.deepEqual(selfHost, {
    apikey: 'test-api-key',
    apiHost: 'https://self.example.com/functions/v1',
    filesHost: 'https://self.example.com/functions/v1',
  }, 'Edge Functions self-host serves files from the same host')

  const customApi = await createCapgoClient('test-api-key', 'https://api.example.com', true)
  assert.equal(customApi.apiHost, 'https://api.example.com')
  assert.equal(customApi.filesHost, defaultFileHost)

  await assert.rejects(() => createCapgoClient('test-api-key', 'http://api.example.com', true), CliUserError)

  // Deprecated --supa-host / --supa-anon fold into apiHost; Capgo-managed projects keep the cloud API.
  assert.deepEqual(normalizeCapgoHostOptions({ apikey: 'k', supaHost: 'https://self.example.com', supaAnon: 'anon' }), {
    apikey: 'k',
    apiHost: 'https://self.example.com/functions/v1',
  })
  assert.deepEqual(normalizeCapgoHostOptions({ apikey: 'k', supaHost: 'https://sb.capgo.app', supaAnon: 'anon' }), { apikey: 'k' })
  assert.deepEqual(normalizeCapgoHostOptions({ apikey: 'k', apiHost: 'https://api.example.com', supaHost: 'https://self.example.com' }), {
    apikey: 'k',
    apiHost: 'https://api.example.com',
  }, 'explicit apiHost wins')

  // Legacy capacitor config `localSupa` (without `localApi`) resolves to its Edge Functions.
  writeFileSync(join(isolatedDir, 'capacitor.config.json'), JSON.stringify({
    appId: 'com.example.legacy',
    appName: 'Legacy',
    webDir: 'dist',
    plugins: { CapacitorUpdater: { localSupa: 'https://legacy.example.com', localSupaAnon: 'anon' } },
  }))
  const legacy = await createCapgoClient('test-api-key', undefined, true)
  assert.equal(legacy.apiHost, 'https://legacy.example.com/functions/v1')
  assert.equal(legacy.filesHost, 'https://legacy.example.com/functions/v1')

  console.log('createCapgoClient host resolution tests passed')
}
finally {
  chdir(originalCwd)
  globalThis.fetch = originalFetch
  rmSync(isolatedDir, { recursive: true, force: true })
}
