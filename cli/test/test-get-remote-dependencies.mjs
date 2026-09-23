#!/usr/bin/env node

import assert from 'node:assert/strict'

const { getRemoteDependencies } = await import('../src/utils.ts')

const options = {
  apikey: 'test-remote-deps-key',
  supaHost: 'http://localhost:54321',
  supaAnon: 'test-anon-key',
}
const appId = 'com.example.app'
const channel = 'production'

const originalFetch = globalThis.fetch
let responseStatus = 200
let responseBody = {}

globalThis.fetch = async (input) => {
  const url = String(input)
  if (!url.includes('channel/current-bundle'))
    return originalFetch(input)
  return new Response(JSON.stringify(responseBody), {
    status: responseStatus,
    headers: { 'Content-Type': 'application/json' },
  })
}

let failures = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  }
  catch (error) {
    failures += 1
    console.error(`❌ ${name}`)
    console.error(error)
  }
}

function setCurrentBundleResponse(body, status = 200) {
  responseStatus = status
  responseBody = body
}

await test('returns empty map when channel row is missing', async () => {
  setCurrentBundleResponse({ error: 'cannot_find_channel', message: 'Cannot find channel' }, 404)
  const result = await getRemoteDependencies(options.apikey, appId, channel, options)
  assert.equal(result.size, 0)
})

await test('returns empty map when channel version has no native packages', async () => {
  setCurrentBundleResponse({
    disable_auto_update: 'major',
    bundle_name: '1.0.0',
    bundle_id: 1,
    min_update_version: null,
    native_packages: null,
  })
  const result = await getRemoteDependencies(options.apikey, appId, channel, options)
  assert.equal(result.size, 0)
})

await test('returns empty map when channel version has empty native packages', async () => {
  setCurrentBundleResponse({
    disable_auto_update: 'major',
    bundle_name: '1.0.0',
    bundle_id: 1,
    min_update_version: null,
    native_packages: [],
  })
  const result = await getRemoteDependencies(options.apikey, appId, channel, options)
  assert.equal(result.size, 0)
})

await test('returns empty map when channel has no linked version', async () => {
  setCurrentBundleResponse({
    disable_auto_update: 'major',
    bundle_name: null,
    bundle_id: null,
    min_update_version: null,
    native_packages: [],
  })
  const result = await getRemoteDependencies(options.apikey, appId, channel, options)
  assert.equal(result.size, 0)
})

await test('maps remote native packages by name', async () => {
  setCurrentBundleResponse({
    disable_auto_update: 'major',
    bundle_name: '1.0.0',
    bundle_id: 1,
    min_update_version: null,
    native_packages: [
      {
        name: '@capacitor/camera',
        version: '6.0.0',
        requested_version: '^6.0.0',
        ios_checksum: 'ios-hash',
        android_checksum: 'android-hash',
      },
    ],
  })
  const result = await getRemoteDependencies(options.apikey, appId, channel, options)
  assert.equal(result.size, 1)
  assert.equal(result.get('@capacitor/camera')?.version, '6.0.0')
})

await test('returns empty map when duplicate channel rows collapse to cannot_find_channel', async () => {
  setCurrentBundleResponse({ error: 'cannot_find_channel', message: 'Cannot find channel' }, 404)
  const result = await getRemoteDependencies(options.apikey, appId, channel, options)
  assert.equal(result.size, 0)
})

await test('throws when current-bundle returns an unexpected API error', async () => {
  setCurrentBundleResponse({ error: 'cannot_access_channel', message: 'You can\'t access this channel' }, 403)

  await assert.rejects(
    () => getRemoteDependencies(options.apikey, appId, channel, options),
    /FunctionsHttpError|cannot_access_channel|403/,
  )
})

globalThis.fetch = originalFetch

if (failures > 0) {
  process.exit(1)
}

console.log('getRemoteDependencies empty native packages tests passed')
