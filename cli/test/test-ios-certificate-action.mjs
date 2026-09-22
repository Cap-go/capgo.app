#!/usr/bin/env node
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { CertificateLimitError } from '../src/build/onboarding/apple-api.ts'
import { runIosEffect } from '../src/build/onboarding/ios/flow.ts'
import { trackCreatedIosCertificateResult, trackImportedIosCertificateSaveResult, trackIosCertificateCreationThrow, trackIosKeychainExportResult } from '../src/build/onboarding/ui/ios-certificate-action.ts'

const journeyId = 'bj_certificate_test'
const actions = []
const trackAction = (action, tags, step) => actions.push({ action, tags, step })
const reportedSuccesses = new Set()
const progress = (setupMethod = 'create-new') => ({
  appId: 'com.example.certificate',
  platform: 'ios',
  startedAt: '2026-01-01T00:00:00.000Z',
  setupMethod,
  ...(setupMethod === 'import-existing' ? { importDistribution: 'ad_hoc' } : {}),
  completedSteps: {},
})

// The create action follows both .p12 creation and persistence of the marker.
const creationOrder = []
const createDeps = {
  generateCsr: () => ({ csr: 'PRIVATE_CSR', privateKeyPem: 'PRIVATE_KEY' }),
  createCertificate: async () => ({ certificateId: 'FAKE_CERT_ID', certificateContent: 'PRIVATE_CERT', expirationDate: '2027-01-01', teamId: 'FAKE_TEAM' }),
  createP12: () => { creationOrder.push('created-p12'); return 'PRIVATE_P12' },
  saveProgress: async (_appId, saved) => {
    assert.equal(saved.completedSteps.certificateCreated.p12Base64, 'PRIVATE_P12')
    creationOrder.push('saved-progress')
  },
}
const created = await runIosEffect('creating-certificate', progress(), createDeps)
trackCreatedIosCertificateResult(created, journeyId, (...args) => {
  creationOrder.push('tracked-action')
  trackAction(...args)
}, reportedSuccesses)
trackCreatedIosCertificateResult(created, journeyId, trackAction, reportedSuccesses)
assert.deepEqual(creationOrder, ['created-p12', 'saved-progress', 'tracked-action'])
assert.deepEqual(actions.splice(0), [{
  action: 'certificate_prepared',
  tags: { attempt_id: journeyId, source: 'created' },
  step: 'creating-certificate',
}])

const failedCreation = await runIosEffect('creating-certificate', progress(), {
  ...createDeps,
  createP12: () => { throw new Error('PRIVATE_CREATE_EXCEPTION') },
})
trackCreatedIosCertificateResult(failedCreation, journeyId, trackAction, reportedSuccesses)
assert.equal(failedCreation.next, 'error')
assert.deepEqual(actions.splice(0), [{
  action: 'certificate_preparation_failed',
  tags: { attempt_id: journeyId, source: 'created', reason: 'create_failed' },
  step: 'creating-certificate',
}])

const limited = await runIosEffect('creating-certificate', progress(), {
  ...createDeps,
  createCertificate: async () => { throw new CertificateLimitError([]) },
  listCertificates: async () => [],
})
trackCreatedIosCertificateResult(limited, journeyId, trackAction, reportedSuccesses)
assert.equal(limited.next, 'cert-limit-prompt')
assert.deepEqual(actions.splice(0), [{
  action: 'certificate_preparation_failed',
  tags: { attempt_id: journeyId, source: 'created', reason: 'certificate_limit' },
  step: 'creating-certificate',
}])

// A failed attempt does not reserve the success key; the retry can report success.
const retrySuccesses = new Set()
trackCreatedIosCertificateResult(failedCreation, journeyId, trackAction, retrySuccesses)
trackCreatedIosCertificateResult(created, journeyId, trackAction, retrySuccesses)
assert.deepEqual(actions.map(event => event.action), ['certificate_preparation_failed', 'certificate_prepared'])
actions.length = 0

const identity = { sha1: 'a'.repeat(40), name: 'Fake Distribution', type: 'distribution', teamId: 'FAKE_TEAM' }
const profile = { path: '/fake.mobileprovision', uuid: 'FAKE_PROFILE', name: 'Fake Profile', expirationDate: '2027-01-01', profileType: 'ad_hoc' }
const importDeps = {
  carried: { chosenIdentity: identity, chosenProfile: profile },
  exportP12FromKeychain: async () => ({ base64: 'PRIVATE_EXPORTED_P12', passphrase: 'PRIVATE_PASSWORD' }),
  readFile: async () => Buffer.from('PRIVATE_PROFILE'),
}
const exported = await runIosEffect('import-exporting', progress('import-existing'), importDeps)
trackIosKeychainExportResult(exported, journeyId, trackAction)
trackImportedIosCertificateSaveResult(exported, exported.transient, journeyId, trackAction, reportedSuccesses)
assert.equal(exported.next, 'saving-credentials')
assert.equal(exported.transient.keychainP12Exported, true)
assert.equal(actions.length, 0, 'export alone is transient and emits no success')

const carried = { ...importDeps.carried, ...exported.transient }
const saveDeps = {
  carried,
  updateSavedCredentials: async (_appId, _platform, credentials) => {
    assert.equal(credentials.BUILD_CERTIFICATE_BASE64, 'PRIVATE_EXPORTED_P12')
  },
  deleteProgress: async () => {},
  loadProgress: async () => null,
}
await assert.rejects(() => runIosEffect('saving-credentials', progress('import-existing'), {
  ...saveDeps,
  updateSavedCredentials: async () => { throw new Error('PRIVATE_SAVE_EXCEPTION') },
}), /PRIVATE_SAVE_EXCEPTION/)
assert.equal(actions.length, 0, 'failed credential save emits no success')

const saved = await runIosEffect('saving-credentials', progress('import-existing'), saveDeps)
trackImportedIosCertificateSaveResult(saved, carried, journeyId, trackAction, reportedSuccesses)
trackImportedIosCertificateSaveResult(saved, carried, journeyId, trackAction, reportedSuccesses)
assert.equal(saved.next, 'ask-build')
assert.deepEqual(actions.splice(0), [{
  action: 'certificate_prepared',
  tags: { attempt_id: journeyId, source: 'keychain_import' },
  step: 'saving-credentials',
}])

const exportFailure = await runIosEffect('import-exporting', progress('import-existing'), {
  ...importDeps,
  exportP12FromKeychain: async () => { throw new Error('PRIVATE_EXPORT_EXCEPTION') },
})
trackIosKeychainExportResult(exportFailure, journeyId, trackAction)
assert.equal(exportFailure.next, 'error')
assert.deepEqual(actions.splice(0), [{
  action: 'certificate_preparation_failed',
  tags: { attempt_id: journeyId, source: 'keychain_import', reason: 'export_failed' },
  step: 'import-exporting',
}])

const missingSelection = await runIosEffect('import-exporting', progress('import-existing'), { carried: {} })
trackIosKeychainExportResult(missingSelection, journeyId, trackAction)
assert.equal(actions.length, 0, 'picker state alone is not an export failure')
assert.doesNotThrow(() => trackIosCertificateCreationThrow(journeyId, () => { throw new Error('telemetry unavailable') }))

console.log('✅ iOS certificate actions follow prepared results and use safe tags')
