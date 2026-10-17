#!/usr/bin/env node

import assert from 'node:assert/strict'
import { chdir, cwd } from 'node:process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCapgoClient, defaultApiHost, defaultFileHost, getLocalConfig, getRemoteConfig, getRemoteFileConfig, normalizeCapgoHostOptions, setCapgoHostOverride, withCapgoHosts } from '../src/utils.ts'
import { CapgoSDK } from '../src/sdk.ts'
import { CliUserError } from '../src/shared/cli-user-error.ts'

const originalFetch = globalThis.fetch
const originalCwd = cwd()
const savedEnv = {
  CAPGO_API_HOST: process.env.CAPGO_API_HOST,
  CAPGO_FILES_HOST: process.env.CAPGO_FILES_HOST,
  CAPGO_TOKEN: process.env.CAPGO_TOKEN,
}
delete process.env.CAPGO_API_HOST
delete process.env.CAPGO_FILES_HOST
delete process.env.CAPGO_TOKEN

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
  // A client keeps its own hosts: nothing process-wide changes.
  assert.equal((await getLocalConfig(true)).hostApi, defaultApiHost)

  // The CLI pins the process (--api-host): files config and uploads hit that backend, never Capgo cloud.
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), capgkey: init?.headers?.capgkey ?? new Headers(init?.headers).get('capgkey'), redirect: init?.redirect })
    throw new Error('network unavailable')
  }
  process.env.CAPGO_TOKEN = 'saved-cloud-key'
  setCapgoHostOverride({ apiHost: 'http://127.0.0.1:8787' })
  assert.equal((await getLocalConfig(true)).hostFilesApi, 'http://127.0.0.1:8787')
  await getRemoteFileConfig()
  assert.equal(requests[0].url, 'http://127.0.0.1:8787/files/config')
  assert.equal(requests[0].capgkey, null, 'saved key never reaches a custom backend')
  assert.equal(requests[0].redirect, 'error', 'config probes never follow redirects')
  await getRemoteFileConfig('self-key')
  assert.equal(requests[1].capgkey, 'self-key', 'the caller key is sent instead')

  // CAPGO_FILES_HOST must not split files away from an explicit API host.
  process.env.CAPGO_FILES_HOST = 'https://files.capgo.app'
  assert.equal((await getLocalConfig(true)).hostFilesApi, 'http://127.0.0.1:8787')
  delete process.env.CAPGO_FILES_HOST

  // A scope never inherits the process pin.
  assert.equal(await withCapgoHosts({}, async () => (await getLocalConfig(true)).hostApi), defaultApiHost)
  setCapgoHostOverride({})

  // Concurrent clients on different backends keep their own host, key and remote config.
  requests.length = 0
  const [clientA, clientB] = await Promise.all([
    createCapgoClient('key-a', 'http://127.0.0.1:8001', true),
    createCapgoClient('key-b', 'http://127.0.0.1:8002', true),
  ])
  assert.equal(clientA.apiHost, 'http://127.0.0.1:8001')
  assert.equal(clientB.apiHost, 'http://127.0.0.1:8002')
  assert.deepEqual(
    requests.map(request => [request.url, request.capgkey]).sort(),
    [['http://127.0.0.1:8001/private/config', 'key-a'], ['http://127.0.0.1:8002/private/config', 'key-b']],
  )
  // Remote config is cached per host.
  requests.length = 0
  globalThis.fetch = async (url) => {
    requests.push({ url: String(url) })
    return new Response(JSON.stringify({ host: String(url) }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  await withCapgoHosts({ apiHost: 'http://127.0.0.1:8001' }, () => getRemoteConfig(true))
  await withCapgoHosts({ apiHost: 'http://127.0.0.1:8002' }, () => getRemoteConfig(true))
  await withCapgoHosts({ apiHost: 'http://127.0.0.1:8001' }, () => getRemoteConfig(true))
  assert.deepEqual(requests.map(request => request.url), ['http://127.0.0.1:8001/private/config', 'http://127.0.0.1:8002/private/config'])
  delete process.env.CAPGO_TOKEN
  globalThis.fetch = async () => {
    throw new Error('network unavailable')
  }

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
  for (const managed of ['https://sb.capgo.app', 'https://xvwzpoazmxkqosrdewyv.supabase.co', 'https://ibwjdnhknbkcqfbabwei.supabase.co', 'https://aucsybvnhavogdmzwtcw.supabase.co'])
    assert.deepEqual(normalizeCapgoHostOptions({ apikey: 'k', supaHost: managed, supaAnon: 'anon' }), { apikey: 'k' }, managed)
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

  // `localApi` alone also serves files; it carries the key, so it must use HTTPS.
  const writeUpdaterConfig = updater => writeFileSync(join(isolatedDir, 'capacitor.config.json'), JSON.stringify({
    appId: 'com.example.self',
    appName: 'Self',
    webDir: 'dist',
    plugins: { CapacitorUpdater: updater },
  }))
  writeUpdaterConfig({ localApi: 'https://self.example.com' })
  assert.deepEqual(await createCapgoClient('test-api-key', undefined, true), { apikey: 'test-api-key', apiHost: 'https://self.example.com', filesHost: 'https://self.example.com' })
  writeUpdaterConfig({ localApi: 'https://self.example.com', localApiFiles: 'https://files.self.example.com' })
  assert.equal((await getLocalConfig(true)).hostFilesApi, 'https://files.self.example.com')
  writeUpdaterConfig({ localApi: 'http://api.example.com' })
  await assert.rejects(() => getLocalConfig(true), CliUserError)

  // Concurrent SDK instances on different backends never share hosts or keys.
  writeUpdaterConfig({})
  const sdkRequests = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.startsWith('http://127.0.0.1'))
      sdkRequests.push(`${new URL(target).host} ${new Headers(init?.headers).get('capgkey')}`)
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  await Promise.all([
    new CapgoSDK({ apikey: 'key-a', apiHost: 'http://127.0.0.1:8001' }).listOrganizations(),
    new CapgoSDK({ apikey: 'key-b', apiHost: 'http://127.0.0.1:8002' }).listOrganizations(),
    new CapgoSDK({ apikey: 'key-c' }).listOrganizations({ apiHost: 'http://127.0.0.1:8003' }),
  ])
  for (const request of sdkRequests) {
    const [host, key] = request.split(' ')
    assert.equal(key, { '127.0.0.1:8001': 'key-a', '127.0.0.1:8002': 'key-b', '127.0.0.1:8003': 'key-c' }[host], request)
  }
  assert.equal(new Set(sdkRequests.map(request => request.split(' ')[0])).size, 3)

  console.log('createCapgoClient host resolution tests passed')
}
finally {
  chdir(originalCwd)
  globalThis.fetch = originalFetch
  setCapgoHostOverride({})
  if (savedEnv.CAPGO_API_HOST === undefined)
    delete process.env.CAPGO_API_HOST
  else
    process.env.CAPGO_API_HOST = savedEnv.CAPGO_API_HOST
  if (savedEnv.CAPGO_FILES_HOST === undefined)
    delete process.env.CAPGO_FILES_HOST
  else
    process.env.CAPGO_FILES_HOST = savedEnv.CAPGO_FILES_HOST
  if (savedEnv.CAPGO_TOKEN === undefined)
    delete process.env.CAPGO_TOKEN
  else
    process.env.CAPGO_TOKEN = savedEnv.CAPGO_TOKEN
  rmSync(isolatedDir, { recursive: true, force: true })
}
