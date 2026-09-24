#!/usr/bin/env node
import assert from 'node:assert/strict'
import { runIosEffect } from '../src/build/onboarding/ios/flow.ts'
import { trackCreatedIosProfileResult, trackImportedIosProfileValidationResult } from '../src/build/onboarding/ui/ios-profile-action.ts'

const journeyId = 'bj_profile_test'
const actions = []
const trackAction = (action, tags, step) => actions.push({ action, tags, step })
const reportedSuccesses = new Set()

const progress = (setupMethod = 'create-new') => ({
  appId: 'com.example.profile',
  platform: 'ios',
  startedAt: '2026-01-01T00:00:00.000Z',
  setupMethod,
  ...(setupMethod === 'import-existing' ? { importDistribution: 'app_store' } : {}),
  completedSteps: {
    certificateCreated: {
      certificateId: 'FAKE_CERT_ID',
      expirationDate: '2027-01-01',
      teamId: 'FAKE_TEAM',
      p12Base64: 'PRIVATE_P12',
    },
  },
})

const profileResult = {
  profileId: 'FAKE_PROFILE_ID',
  profileName: 'Fake Profile',
  profileBase64: 'PRIVATE_PROFILE',
}

// Create-new reports only after the complete profile marker is persisted.
const creationOrder = []
const created = await runIosEffect('creating-profile', progress(), {
  createProfile: async () => profileResult,
  saveProgress: async (_appId, saved) => {
    assert.deepEqual(saved.completedSteps.profileCreated, profileResult)
    creationOrder.push('saved-progress')
  },
})
trackCreatedIosProfileResult(created, 'creating-profile', journeyId, (...args) => {
  creationOrder.push('tracked-action')
  trackAction(...args)
}, reportedSuccesses)
trackCreatedIosProfileResult(created, 'creating-profile', journeyId, trackAction, reportedSuccesses)
assert.deepEqual(creationOrder, ['saved-progress', 'tracked-action'])
assert.deepEqual(actions.splice(0), [{
  action: 'profile_prepared',
  tags: { attempt_id: journeyId, source: 'created' },
  step: 'creating-profile',
}])

const identity = { sha1: 'a'.repeat(40), name: 'Fake Distribution', type: 'distribution', teamId: 'FAKE_TEAM' }
const importedProfile = {
  path: '/fake.mobileprovision',
  uuid: 'FAKE_IMPORTED_PROFILE',
  name: 'Imported Profile',
  applicationIdentifier: 'FAKE_TEAM.com.example.profile',
  bundleId: 'com.example.profile',
  teamId: 'FAKE_TEAM',
  expirationDate: '2027-01-01',
  profileType: 'app_store',
  certificateSha1s: [identity.sha1],
  profileEntitlements: {},
}

// Import reports only after the engine has validated bundle, distribution,
// and certificate pairing, and only once for the selected profile.
const importedProgress = progress('import-existing')
const importedCarried = { chosenIdentity: identity, chosenProfile: importedProfile }
const validated = await runIosEffect('import-pick-profile', importedProgress, {
  carried: importedCarried,
})
trackImportedIosProfileValidationResult(validated, importedCarried, journeyId, trackAction, reportedSuccesses)
trackImportedIosProfileValidationResult(validated, importedCarried, journeyId, trackAction, reportedSuccesses)
assert.equal(validated.next, 'import-export-warning')
assert.deepEqual(actions.splice(0), [{
  action: 'profile_prepared',
  tags: { attempt_id: journeyId, source: 'imported' },
  step: 'import-pick-profile',
}])

// Creating a profile while recovering an import still reports its true source.
const recoveryCreated = await runIosEffect('import-create-profile-only', importedProgress, {
  carried: { chosenIdentity: identity, importMatches: [{ identity, profiles: [] }] },
  findCertIdBySha1: async () => 'FAKE_CERT_ID',
  ensureBundleId: async () => {},
  createProfile: async () => ({ ...profileResult, expirationDate: '2027-01-01' }),
})
trackCreatedIosProfileResult(recoveryCreated, 'import-create-profile-only', journeyId, trackAction, reportedSuccesses)
assert.equal(recoveryCreated.next, 'import-export-warning')
assert.deepEqual(actions.splice(0), [{
  action: 'profile_prepared',
  tags: { attempt_id: journeyId, source: 'created' },
  step: 'import-create-profile-only',
}])

const invalidCarried = {
  chosenIdentity: identity,
  chosenProfile: { ...importedProfile, uuid: 'FAKE_INVALID_PROFILE', bundleId: 'com.example.other' },
}
const invalid = await runIosEffect('import-pick-profile', importedProgress, { carried: invalidCarried })
trackImportedIosProfileValidationResult(invalid, invalidCarried, journeyId, trackAction, reportedSuccesses)
assert.equal(invalid.next, 'error')
assert.equal(actions.length, 0, 'invalid profiles emit no success')

assert.doesNotThrow(() => trackImportedIosProfileValidationResult(
  validated,
  importedCarried,
  journeyId,
  () => { throw new Error('telemetry unavailable') },
  new Set(),
))

const safeEvents = JSON.stringify(actions)
assert.equal(safeEvents.includes('PRIVATE_PROFILE'), false)

console.log('✅ iOS profile actions follow created or validated results and emit once')
