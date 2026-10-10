#!/usr/bin/env node

import assert from 'node:assert/strict'
import { chdir, cwd } from 'node:process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCapgoClient, defaultApiHost, defaultFileHost, getLocalConfig, getRemoteFileConfig, normalizeCapgoHostOptions, setCapgoHostOverride } from '../src/utils.ts'
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

  // Any Capgo backend works (workers, custom domain, local test server); it serves files too.
  const customApi = await createCapgoClient('test-api-key', 'http://127.0.0.1:8787', true)
  assert.deepEqual(customApi, { apikey: 'test-api-key', apiHost: 'http://127.0.0.1:8787', filesHost: 'http://127.0.0.1:8787' })
  // The client pins the process: files config and uploads hit the same backend, never Capgo cloud.
  assert.equal((await getLocalConfig(true)).hostFilesApi, 'http://127.0.0.1:8787')
  const fileConfigUrls = []
  globalThis.fetch = async (url) => {
    fileConfigUrls.push(String(url))
    throw new Error('network unavailable')
  }
  await getRemoteFileConfig()
  assert.deepEqual(fileConfigUrls, ['http://127.0.0.1:8787/files/config'])

  const splitHosts = await createCapgoClient('test-api-key', 'https://api.example.com', true, undefined, 'https://files.example.com')
  assert.equal(splitHosts.apiHost, 'https://api.example.com')
  assert.equal(splitHosts.filesHost, 'https://files.example.com')

  await assert.rejects(() => createCapgoClient('test-api-key', 'http://api.example.com', true), CliUserError)
  setCapgoHostOverride({})

  // Env vars select the backend for tests / CI without flags.
  process.env.CAPGO_API_HOST = 'http://localhost:8787'
  process.env.CAPGO_FILES_HOST = 'http://localhost:8789'
  assert.deepEqual(await createCapgoClient('test-api-key', undefined, true), { apikey: 'test-api-key', apiHost: 'http://localhost:8787', filesHost: 'http://localhost:8789' })
  delete process.env.CAPGO_API_HOST
  delete process.env.CAPGO_FILES_HOST

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

  setCapgoHostOverride({})
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
