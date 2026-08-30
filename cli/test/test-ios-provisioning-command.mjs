#!/usr/bin/env node

import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeProfileXml } from './prescan/helpers.ts'
import { DuplicateProfileError, runIosProvisioningCommand } from '../src/build/ios-provisioning-command.ts'

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

function generationCredentials(provisioningMap, extra = {}) {
  return iosCredentials(provisioningMap, {
    APPLE_KEY_ID: 'KEY1234567',
    APPLE_ISSUER_ID: '11111111-2222-3333-4444-555555555555',
    APPLE_KEY_CONTENT: Buffer.from('test-p8-pem').toString('base64'),
    BUILD_CERTIFICATE_BASE64: 'test-p12-base64',
    ...extra,
  })
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

  let storeReads = 0
  const invalid = baseDeps({
    loadStores: async () => {
      storeReads++
      return { local: exact, global: exact }
    },
  })
  await assert.rejects(runIosProvisioningCommand({ local: true, global: true }, invalid.deps), /cannot use --local and --global together/i)
  assert.equal(storeReads, 0)
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

await test('validates local p8, API access, P12, and Apple certificate before generation confirmation', async () => {
  const events = []
  let p12Password
  const { deps, state } = baseDeps({
    loadProject: async () => ({ appId: 'com.example.app', targets: [appTarget()] }),
    loadStores: async () => ({ local: generationCredentials(map({ old: profile('org.other.app') })), global: null }),
    generateJwt: (_keyId, _issuerId, pem) => {
      events.push(`jwt:${pem}`)
      return 'token'
    },
    verifyApiKey: async () => events.push('verify'),
    openP12: (_certificate, password) => {
      p12Password = password
      events.push('p12')
      return { sha1: 'a'.repeat(40) }
    },
    findCertBySha1: async () => {
      events.push('cert')
      return { id: 'cert-id' }
    },
    confirm: async (message) => {
      events.push('confirm')
      state.prompts.push(message)
      return false
    },
  })
  await assert.rejects(runIosProvisioningCommand({}, deps), /generation was declined/i)
  assert.equal(p12Password, '')
  assert.deepEqual(events, ['jwt:test-p8-pem', 'verify', 'p12', 'jwt:test-p8-pem', 'cert', 'confirm'])
  assert.equal(state.writes.length, 0)
})

await test('invalid p8 and inaccessible Apple keys fail before confirmation without leaking credential values', async () => {
  const malformed = baseDeps({
    loadStores: async () => ({ local: generationCredentials(map({ old: profile('org.other.app') }), { APPLE_KEY_CONTENT: '***' }), global: null }),
  })
  await assert.rejects(runIosProvisioningCommand({}, malformed.deps), /saved App Store Connect \.p8 key is invalid/i)
  assert.equal(malformed.state.appleCalls.length, 0)

  const secret = Buffer.from('very-secret-p8').toString('base64')
  const invalid = baseDeps({
    loadStores: async () => ({ local: generationCredentials(map({ old: profile('org.other.app') }), { APPLE_KEY_CONTENT: secret }), global: null }),
    generateJwt: () => { throw new Error(`bad ${secret}`) },
  })
  let p8Error
  try {
    await runIosProvisioningCommand({}, invalid.deps)
  }
  catch (error) {
    p8Error = error
  }
  assert.match(p8Error.message, /saved App Store Connect \.p8 key is invalid/i)
  assert.doesNotMatch(p8Error.message, new RegExp(secret))
  assert.equal(invalid.state.prompts.length, 0)

  const inaccessible = baseDeps({
    loadStores: async () => ({ local: generationCredentials(map({ old: profile('org.other.app') })), global: null }),
    verifyApiKey: async () => { throw new Error('access rejected') },
  })
  await assert.rejects(runIosProvisioningCommand({}, inaccessible.deps), /does not have access/i)
  assert.equal(inaccessible.state.prompts.length, 0)
  assert.deepEqual(inaccessible.state.appleCalls, ['generateJwt'])
})

await test('invalid P12 and an Apple certificate mismatch fail before generation confirmation', async () => {
  const badP12 = baseDeps({
    loadStores: async () => ({ local: generationCredentials(map({ old: profile('org.other.app') })), global: null }),
    openP12: () => { throw new Error('bad certificate') },
  })
  await assert.rejects(runIosProvisioningCommand({}, badP12.deps), /signing certificate or P12 password is invalid/i)
  assert.equal(badP12.state.prompts.length, 0)

  const noMatch = baseDeps({
    loadStores: async () => ({ local: generationCredentials(map({ old: profile('org.other.app') })), global: null }),
    findCertBySha1: async () => null,
  })
  await assert.rejects(runIosProvisioningCommand({}, noMatch.deps), /certificate is not available.*\.p8 key/i)
  assert.equal(noMatch.state.prompts.length, 0)
})

await test('generates targets sequentially with fresh JWTs and persists after each success', async () => {
  const events = []
  let jwt = 0
  const { deps, state } = baseDeps({
    loadProject: async () => ({ appId: 'com.example.app', targets: [appTarget(), widgetTarget()] }),
    loadStores: async () => ({ local: generationCredentials(map({ old: profile('org.other.app') }), { APPLE_APP_SPECIFIC_PASSWORD: 'ignored' }), global: null }),
    generateJwt: () => `token-${++jwt}`,
    verifyApiKey: async token => events.push(`verify:${token}`),
    findCertBySha1: async token => {
      events.push(`cert:${token}`)
      return { id: 'cert-id' }
    },
    ensureBundleId: async (token, bundleId) => {
      events.push(`ensure:${token}:${bundleId}`)
      return { bundleIdResourceId: `resource-${bundleId}` }
    },
    createProfile: async (token, resourceId, certId, bundleId) => {
      events.push(`create:${token}:${resourceId}:${certId}:${bundleId}`)
      return { profileId: `profile-${bundleId}`, profileName: `Capgo ${bundleId}`, profileContent: profile(bundleId) }
    },
  })
  await runIosProvisioningCommand({}, deps)

  assert.equal(state.prompts.length, 1)
  assert.equal(state.writes.length, 2)
  assert.ok(state.writes[0].value['com.example.app'])
  assert.equal(state.writes[0].value['com.example.app.widget'], undefined)
  assert.ok(state.writes[1].value['com.example.app.widget'])
  assert.deepEqual(events, [
    'verify:token-1',
    'cert:token-2',
    'ensure:token-3:com.example.app',
    'create:token-4:resource-com.example.app:cert-id:com.example.app',
    'ensure:token-5:com.example.app.widget',
    'create:token-6:resource-com.example.app.widget:cert-id:com.example.app.widget',
  ])
})

await test('keeps earlier persisted profiles when a later target fails', async () => {
  let creates = 0
  const { deps, state } = baseDeps({
    loadProject: async () => ({ appId: 'com.example.app', targets: [appTarget(), widgetTarget()] }),
    loadStores: async () => ({ local: generationCredentials(map({ old: profile('org.other.app') })), global: null }),
    createProfile: async (_token, _resource, _cert, bundleId) => {
      creates++
      if (creates === 2)
        throw new Error('Apple create failed')
      return { profileId: 'first', profileName: 'First', profileContent: profile(bundleId) }
    },
  })
  await assert.rejects(runIosProvisioningCommand({}, deps), /could not create.*Widget/i)
  assert.equal(state.writes.length, 1)
  assert.ok(state.writes[0].value['com.example.app'])
})

await test('replaces only duplicate profiles after confirmation and retries creation once', async () => {
  const duplicates = [
    { id: 'duplicate-1', name: 'Capgo one', profileType: 'IOS_APP_STORE' },
    { id: 'duplicate-2', name: 'Capgo two', profileType: 'IOS_APP_STORE' },
  ]
  let creates = 0
  const deleted = []
  const { deps, state } = baseDeps({
    loadStores: async () => ({ local: generationCredentials(map({ old: profile('org.other.app') })), global: null }),
    createProfile: async (_token, _resource, _cert, bundleId) => {
      creates++
      if (creates === 1)
        throw new DuplicateProfileError(duplicates)
      return { profileId: 'replacement', profileName: 'Replacement', profileContent: profile(bundleId) }
    },
    deleteProfile: async (_token, id) => deleted.push(id),
  })
  await runIosProvisioningCommand({}, deps)

  assert.equal(state.prompts.length, 2)
  assert.match(state.prompts[1], /Capgo one.*Capgo two/s)
  assert.deepEqual(deleted, ['duplicate-1', 'duplicate-2'])
  assert.equal(creates, 2)
  assert.equal(state.writes.length, 1)
})

await test('duplicate decline and replacement retry failure stop without recursive deletion', async () => {
  const duplicate = new DuplicateProfileError([{ id: 'duplicate-1', name: 'Existing', profileType: 'IOS_APP_STORE' }])
  let prompt = 0
  const declined = baseDeps({
    loadStores: async () => ({ local: generationCredentials(map({ old: profile('org.other.app') })), global: null }),
    confirm: async (message) => {
      declined.state.prompts.push(message)
      return ++prompt === 1
    },
    createProfile: async () => { throw duplicate },
  })
  await assert.rejects(runIosProvisioningCommand({}, declined.deps), /replacement was declined/i)
  assert.equal(declined.state.appleCalls.includes('deleteProfile'), false)

  let deletes = 0
  const retry = baseDeps({
    loadStores: async () => ({ local: generationCredentials(map({ old: profile('org.other.app') })), global: null }),
    createProfile: async () => { throw duplicate },
    deleteProfile: async () => { deletes++ },
  })
  await assert.rejects(runIosProvisioningCommand({}, retry.deps), /were deleted.*could not be created/i)
  assert.equal(deletes, 1)
  assert.equal(retry.state.writes.length, 0)
})

await test('duplicate replacement requires a second interactive confirmation and reports deletion failure', async () => {
  const duplicate = new DuplicateProfileError([{ id: 'duplicate-1', name: 'Existing', profileType: 'IOS_APP_STORE' }])
  let promptChecks = 0
  const noninteractive = baseDeps({
    loadStores: async () => ({ local: generationCredentials(map({ old: profile('org.other.app') })), global: null }),
    canPrompt: () => ++promptChecks === 1,
    createProfile: async () => { throw duplicate },
  })
  await assert.rejects(runIosProvisioningCommand({}, noninteractive.deps), /interactive terminal/i)
  assert.equal(noninteractive.state.appleCalls.includes('deleteProfile'), false)

  const deleteFailure = baseDeps({
    loadStores: async () => ({ local: generationCredentials(map({ old: profile('org.other.app') })), global: null }),
    createProfile: async () => { throw duplicate },
    deleteProfile: async () => { throw new Error('delete failed') },
  })
  await assert.rejects(runIosProvisioningCommand({}, deleteFailure.deps), /could not delete all existing/i)
  assert.equal(deleteFailure.state.writes.length, 0)
})

await test('registers lowercase ios-provisioning help with only the supported command options', () => {
  const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const help = spawnSync(process.execPath, [resolve(cliDir, 'dist/index.js'), 'build', 'credentials', 'ios-provisioning', '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /Usage: @capgo\/cli build credentials ios-provisioning \[options\]/)
  assert.match(help.stdout, /--local/)
  assert.match(help.stdout, /--global/)
  assert.match(help.stdout, /npx @capgo\/cli@latest build credentials ios-provisioning/)
  assert.doesNotMatch(help.stdout, /--app-?[iI]d|--yes/)
})

console.log(`\n✅ iOS provisioning command tests passed (${passed})`)
