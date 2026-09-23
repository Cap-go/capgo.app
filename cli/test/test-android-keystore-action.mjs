#!/usr/bin/env node
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { runAndroidEffect } from '../src/build/onboarding/android/flow.ts'
import { trackAndroidKeystorePreparationFailure, trackPreparedAndroidKeystore } from '../src/build/onboarding/android/ui/keystore-action.ts'

const journeyId = 'bj_keystore_test'
const actions = []
const trackAction = (action, tags, step) => actions.push({ action, tags, step })
const reportedSuccesses = new Set()

const generatedProgress = () => ({
  appId: 'com.example.keystore',
  platform: 'android',
  startedAt: '2026-01-01T00:00:00.000Z',
  keystoreMethod: 'generate',
  keystoreAlias: 'release',
  keystoreStorePassword: 'PRIVATE_STORE_PASSWORD',
  keystoreKeyPassword: 'PRIVATE_KEY_PASSWORD',
  keystoreCommonName: 'Private Customer Name',
  completedSteps: {},
})

const generatedOrder = []
const generated = await runAndroidEffect('keystore-generating', generatedProgress(), {
  generateKeystore: () => ({
    p12Base64: 'PRIVATE_GENERATED_KEYSTORE',
    p12Bytes: Buffer.from('PRIVATE_GENERATED_KEYSTORE'),
    alias: 'release',
    notAfter: new Date('2050-01-01T00:00:00.000Z'),
  }),
  saveAndroidProgress: async (_appId, saved) => {
    assert.equal(saved._keystoreBase64, 'PRIVATE_GENERATED_KEYSTORE')
    assert.equal(saved.completedSteps.keystoreReady.isGenerated, true)
    generatedOrder.push('saved-progress')
  },
})
trackPreparedAndroidKeystore(generated.progress, 'generated', 'generated_with_keystore', journeyId, (...args) => {
  generatedOrder.push('tracked-action')
  trackAction(...args)
}, reportedSuccesses)
trackPreparedAndroidKeystore(generated.progress, 'generated', 'generated_with_keystore', journeyId, trackAction, reportedSuccesses)
assert.deepEqual(generatedOrder, ['saved-progress', 'tracked-action'])
assert.deepEqual(actions.splice(0), [{
  action: 'keystore_prepared',
  tags: {
    attempt_id: journeyId,
    source: 'generated',
    key_password: 'generated_with_keystore',
  },
  step: 'keystore-generating',
}])

const importedProgress = keyPassword => ({
  appId: 'com.example.keystore',
  platform: 'android',
  startedAt: '2026-01-01T00:00:00.000Z',
  keystoreMethod: 'existing',
  keystoreExistingPath: '/private/customer-upload-key.p12',
  keystoreAlias: 'private-customer-alias',
  keystoreStorePassword: 'PRIVATE_STORE_PASSWORD',
  ...(keyPassword ? { keystoreKeyPassword: keyPassword } : {}),
  completedSteps: {},
})

async function prepareImported(progress, probeResult) {
  let persisted = null
  const order = []
  const result = await runAndroidEffect('keystore-existing-key-password', progress, {
    readFile: async () => Buffer.from('PRIVATE_IMPORTED_KEYSTORE'),
    tryUnlockPrivateKey: () => probeResult,
    saveAndroidProgress: async (_appId, saved) => {
      persisted = saved
      order.push('saved-progress')
    },
    loadAndroidProgress: async () => persisted,
  })
  return { result, order }
}

const verifiedImport = await prepareImported(importedProgress(), { ok: true })
trackPreparedAndroidKeystore(verifiedImport.result.progress, 'imported', 'verified', journeyId, (...args) => {
  verifiedImport.order.push('tracked-action')
  trackAction(...args)
}, reportedSuccesses)
assert.deepEqual(verifiedImport.order, ['saved-progress', 'tracked-action'])
assert.deepEqual(actions.splice(0), [{
  action: 'keystore_prepared',
  tags: {
    attempt_id: journeyId,
    source: 'imported',
    key_password: 'verified',
  },
  step: 'keystore-existing-key-password',
}])

// A separately entered key password is valid preparation input even though a
// build has not verified it yet.
const separateSuccesses = new Set()
const separateImport = await prepareImported(importedProgress('PRIVATE_SEPARATE_KEY_PASSWORD'), {
  ok: false,
  reason: 'wrong-password',
  message: 'PRIVATE_RAW_PROBE_ERROR',
})
trackPreparedAndroidKeystore(separateImport.result.progress, 'imported', 'not_checked', journeyId, trackAction, separateSuccesses)
assert.deepEqual(actions.splice(0), [{
  action: 'keystore_prepared',
  tags: {
    attempt_id: journeyId,
    source: 'imported',
    key_password: 'not_checked',
  },
  step: 'keystore-existing-key-password',
}])

// A failed same-password probe only opens the separate key-password question.
// It is not a preparation failure.
const promptResult = await runAndroidEffect('keystore-existing-key-password', importedProgress(), {
  readFile: async () => Buffer.from('PRIVATE_IMPORTED_KEYSTORE'),
  tryUnlockPrivateKey: () => ({
    ok: false,
    reason: 'wrong-password',
    message: 'PRIVATE_RAW_PROBE_ERROR',
  }),
})
assert.equal(promptResult.next, 'keystore-existing-key-password')
assert.equal(promptResult.transient.needsKeyPasswordPrompt, true)
assert.equal(actions.length, 0)

// Genuine generation and import work failures emit safe categorical outcomes.
await assert.rejects(() => runAndroidEffect('keystore-generating', generatedProgress(), {
  generateKeystore: () => { throw new Error('PRIVATE_GENERATION_ERROR') },
}), /PRIVATE_GENERATION_ERROR/)
trackAndroidKeystorePreparationFailure('generated', 'generated_with_keystore', 'generate_failed', journeyId, trackAction)

await assert.rejects(() => runAndroidEffect('keystore-existing-key-password', importedProgress('PRIVATE_SEPARATE_KEY_PASSWORD'), {
  readFile: async () => { throw new Error('PRIVATE_IMPORT_ERROR') },
}), /PRIVATE_IMPORT_ERROR/)
trackAndroidKeystorePreparationFailure('imported', 'not_checked', 'import_failed', journeyId, trackAction)
assert.deepEqual(actions.splice(0), [
  {
    action: 'keystore_preparation_failed',
    tags: {
      attempt_id: journeyId,
      source: 'generated',
      reason: 'generate_failed',
      key_password: 'generated_with_keystore',
    },
    step: 'keystore-generating',
  },
  {
    action: 'keystore_preparation_failed',
    tags: {
      attempt_id: journeyId,
      source: 'imported',
      reason: 'import_failed',
      key_password: 'not_checked',
    },
    step: 'keystore-existing-key-password',
  },
])

// A failed attempt does not reserve the success key, so a retry can still
// report preparation.
trackAndroidKeystorePreparationFailure('generated', 'generated_with_keystore', 'generate_failed', journeyId, trackAction)
const retrySuccesses = new Set()
trackPreparedAndroidKeystore(generated.progress, 'generated', 'generated_with_keystore', journeyId, trackAction, retrySuccesses)
assert.deepEqual(actions.map(event => event.action), ['keystore_preparation_failed', 'keystore_prepared'])

const safeEvents = JSON.stringify(actions)
for (const secret of [
  'PRIVATE_STORE_PASSWORD',
  'PRIVATE_KEY_PASSWORD',
  'PRIVATE_SEPARATE_KEY_PASSWORD',
  'PRIVATE_GENERATED_KEYSTORE',
  'PRIVATE_RAW_PROBE_ERROR',
  'PRIVATE_GENERATION_ERROR',
  'PRIVATE_IMPORT_ERROR',
  'private-customer-alias',
  '/private/customer-upload-key.p12',
]) {
  assert.equal(safeEvents.includes(secret), false, `telemetry leaked ${secret}`)
}
actions.length = 0

// Incomplete data or an unsaved marker never counts as prepared.
trackPreparedAndroidKeystore({
  ...generated.progress,
  completedSteps: {},
}, 'generated', 'generated_with_keystore', journeyId, trackAction, new Set())
assert.equal(actions.length, 0)
assert.doesNotThrow(() => trackAndroidKeystorePreparationFailure(
  'imported',
  'not_checked',
  'import_failed',
  journeyId,
  () => { throw new Error('telemetry unavailable') },
))

console.log('✅ Android keystore actions follow persisted outcomes and use safe tags')
