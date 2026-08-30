#!/usr/bin/env node

import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { makeProfileXml } from './prescan/helpers.ts'
import { runIosProvisioningCommand } from '../src/build/ios-provisioning-command.ts'

let passed = 0

async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`✅ PASSED: ${name}`)
  }
  catch (error) {
    console.error(`❌ FAILED: ${name}`)
    throw error
  }
}

function profile(bundleId, name = 'Test Profile') {
  return Buffer.from(makeProfileXml({ bundleId }).replace('<string>Test Profile</string>', `<string>${name}</string>`)).toString('base64')
}

function map(entries) {
  return JSON.stringify(entries)
}

function appTarget(bundleId = 'com.example.app') {
  return { name: 'App', bundleId, productType: 'com.apple.product-type.application' }
}

function widgetTarget(bundleId = 'com.example.app.widget') {
  return { name: 'Widget', bundleId, productType: 'com.apple.product-type.app-extension' }
}

function iosCredentials(provisioningMap, extra = {}) {
  return { ios: { CAPGO_IOS_PROVISIONING_MAP: provisioningMap, ...extra } }
}

function baseDeps(overrides = {}) {
  const state = { prompts: [], writes: [], logs: [], appleCalls: [] }
  const deps = {
    loadProject: async () => ({ appId: 'com.example.app', targets: [appTarget()] }),
    loadStores: async () => ({
      local: iosCredentials(map({ 'com.example.app': profile('com.example.app') })),
      global: null,
    }),
    persistMap: async (appId, source, value) => state.writes.push({ appId, source, value: structuredClone(value) }),
    canPrompt: () => true,
    confirm: async (message) => {
      state.prompts.push(message)
      return true
    },
    logInfo: message => state.logs.push(message),
    generateJwt: () => {
      state.appleCalls.push('generateJwt')
      return 'token'
    },
    verifyApiKey: async () => state.appleCalls.push('verifyApiKey'),
    openP12: () => {
      state.appleCalls.push('openP12')
      return { sha1: 'a'.repeat(40) }
    },
    findCertBySha1: async () => {
      state.appleCalls.push('findCertBySha1')
      return { id: 'cert-id' }
    },
    ensureBundleId: async () => {
      state.appleCalls.push('ensureBundleId')
      return { bundleIdResourceId: 'bundle-id' }
    },
    createProfile: async () => {
      state.appleCalls.push('createProfile')
      return { profileId: 'profile-id', profileName: 'Created', profileContent: profile('com.example.app') }
    },
    deleteProfile: async () => state.appleCalls.push('deleteProfile'),
    ...overrides,
  }
  return { deps, state }
}

await test('rejects an empty app id, no targets, and unresolved target bundle ids before store reads', async () => {
  for (const [project, expected] of [
    [{ appId: '', targets: [appTarget()] }, /app id/i],
    [{ appId: 'com.example.app', targets: [] }, /signable/i],
    [{ appId: 'com.example.app', targets: [appTarget('$(PRODUCT_BUNDLE_IDENTIFIER)')] }, /resolve.*bundle id/i],
  ]) {
    let storeReads = 0
    const { deps } = baseDeps({
      loadProject: async () => project,
      loadStores: async () => {
        storeReads++
        return { local: null, global: null }
      },
    })
    await assert.rejects(runIosProvisioningCommand({}, deps), expected)
    assert.equal(storeReads, 0)
  }
})

await test('uses the Capacitor app id for source selection and follows shared split-store rules', async () => {
  let loadedAppId
  const exact = iosCredentials(map({ 'com.example.app': profile('com.example.app') }))
  const { deps } = baseDeps({
    loadStores: async (appId) => {
      loadedAppId = appId
      return { local: exact, global: exact }
    },
  })
  await assert.rejects(runIosProvisioningCommand({}, deps), /pass --local or --global/i)
  assert.equal(loadedAppId, 'com.example.app')
  await runIosProvisioningCommand({ local: true }, deps)
})

await test('requires existing iOS credentials and a valid nonempty provisioning map', async () => {
  for (const [saved, expected] of [
    [{ android: { ANDROID_KEYSTORE_FILE: 'store' } }, /iOS Builder credentials/i],
    [{ ios: {} }, /No saved Builder credentials/i],
    [{ ios: { BUILD_CERTIFICATE_BASE64: 'cert' } }, /provisioning profile map.*saved/i],
    [iosCredentials('{}'), /no profiles/i],
    [iosCredentials('{broken'), /valid JSON/i],
    [iosCredentials(map({ bad: 'not-a-profile' })), /bad.*invalid/i],
  ]) {
    const { deps } = baseDeps({ loadStores: async () => ({ local: saved, global: null }) })
    await assert.rejects(runIosProvisioningCommand({}, deps), expected)
  }
})

await test('rejects ad hoc but ignores app-specific passwords when exact coverage is complete', async () => {
  const exactMap = map({ 'com.example.app': profile('com.example.app') })
  const adHoc = baseDeps({
    loadStores: async () => ({ local: iosCredentials(exactMap, { CAPGO_IOS_DISTRIBUTION: 'ad_hoc' }), global: null }),
  })
  await assert.rejects(runIosProvisioningCommand({}, adHoc.deps), /ad hoc.*not supported/i)

  const complete = baseDeps({
    loadStores: async () => ({
      local: iosCredentials(exactMap, { APPLE_APP_SPECIFIC_PASSWORD: 'ignored', APPLE_APP_ID: 'ignored' }),
      global: null,
    }),
  })
  await runIosProvisioningCommand({}, complete.deps)
  assert.equal(complete.state.prompts.length, 0)
  assert.equal(complete.state.appleCalls.length, 0)
  assert.match(complete.state.logs.at(-1), /all iOS targets/i)
})

await test('confirms one wildcard reuse and persists exact canonical entries in one write', async () => {
  const wildcard = profile('com.example.*', 'Wildcard Profile')
  const { deps, state } = baseDeps({
    loadProject: async () => ({ appId: 'com.example.app', targets: [appTarget(), widgetTarget()] }),
    loadStores: async () => ({ local: iosCredentials(map({ wildcard })), global: null }),
  })
  await runIosProvisioningCommand({}, deps)

  assert.equal(state.prompts.length, 1)
  assert.match(state.prompts[0], /App.*com\.example\.app.*Widget.*com\.example\.app\.widget/s)
  assert.equal(state.writes.length, 1)
  assert.equal(state.writes[0].source, 'local')
  assert.deepEqual(state.writes[0].value['com.example.app'], { profile: wildcard, name: 'Wildcard Profile' })
  assert.deepEqual(state.writes[0].value['com.example.app.widget'], { profile: wildcard, name: 'Wildcard Profile' })
  assert.equal(state.appleCalls.length, 0)
})

await test('requires an interactive terminal when wildcard confirmation is needed', async () => {
  const { deps, state } = baseDeps({
    loadProject: async () => ({ appId: 'com.example.app', targets: [widgetTarget()] }),
    loadStores: async () => ({ local: iosCredentials(map({ wildcard: profile('*') })), global: null }),
    canPrompt: () => false,
  })
  await assert.rejects(runIosProvisioningCommand({}, deps), /interactive terminal/i)
  assert.equal(state.prompts.length, 0)
  assert.equal(state.writes.length, 0)
})

await test('declining wildcard reuse falls through to dedicated generation requirements', async () => {
  const { deps, state } = baseDeps({
    loadProject: async () => ({ appId: 'com.example.app', targets: [widgetTarget()] }),
    loadStores: async () => ({
      local: iosCredentials(map({ wildcard: profile('*') }), { APPLE_APP_SPECIFIC_PASSWORD: 'not-supported' }),
      global: null,
    }),
    confirm: async (message) => {
      state.prompts.push(message)
      return false
    },
  })
  await assert.rejects(runIosProvisioningCommand({}, deps), /app-specific password.*not supported/i)
  assert.equal(state.writes.length, 0)
})

await test('fails before prompting or writing when different wildcard profiles match', async () => {
  const { deps, state } = baseDeps({
    loadProject: async () => ({ appId: 'com.example.app', targets: [widgetTarget()] }),
    loadStores: async () => ({
      local: iosCredentials(map({ broad: profile('*', 'Broad'), prefix: profile('com.example.*', 'Prefix') })),
      global: null,
    }),
  })
  await assert.rejects(
    runIosProvisioningCommand({}, deps),
    /Sorry, multiple matching wildcard provisioning profiles are not supported/,
  )
  assert.equal(state.prompts.length, 0)
  assert.equal(state.writes.length, 0)
})

console.log(`\n✅ iOS provisioning command tests passed (${passed})`)
