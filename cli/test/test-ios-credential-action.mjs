#!/usr/bin/env node
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { runIosEffect } from '../src/build/onboarding/ios/flow.ts'
import { trackGuidedKeyValidationFailure, trackVerifiedIosKey, verifyIosKeyWithTelemetry } from '../src/build/onboarding/ui/ios-credential-action.ts'

const journeyId = 'bj_test-journey'
const actions = []
const emitted = []
const trackAction = (action, tags, step) => {
  const event = { action, tags, step }
  actions.push(event)
  emitted.push(event)
}
const progress = () => ({
  appId: 'com.example.app',
  platform: 'ios',
  startedAt: '2026-01-01T00:00:00.000Z',
  completedSteps: {},
  keyId: 'SECRET_KEY_ID',
  issuerId: 'SECRET_ISSUER_ID',
  p8Path: '/secret/AuthKey_SECRET_KEY_ID.p8',
})

// The helper's own validation event is the only guided-path failure signal.
trackGuidedKeyValidationFailure('validation_failed', journeyId, trackAction)
assert.deepEqual(actions.shift(), {
  action: 'credential_verification_failed',
  tags: {
    credential: 'ios_app_store_connect_api_key',
    attempt_id: journeyId,
    source: 'guided_helper',
  },
  step: 'asc-key-generating',
})
trackGuidedKeyValidationFailure('helper_cancelled', journeyId, trackAction)
trackGuidedKeyValidationFailure('validation_failed', journeyId, trackAction, true)
assert.equal(actions.length, 0, 'manual exit and cancellation emit no failure action')

// The original Apple error still reaches the engine unchanged. Only the mapper's
// safe category reaches the action, even though the engine later drops status.
const appleError = Object.assign(new Error('PRIVATE_RAW_ERROR'), { status: 403 })
const failure = await runIosEffect('verifying-key', progress(), {
  carried: { p8Content: Buffer.from('PRIVATE_P8_CONTENT') },
  verifyApiKey: () => verifyIosKeyWithTelemetry(
    async () => { throw appleError }, journeyId, trackAction, () => false,
  ),
})
assert.equal(failure.next, 'error')
assert.equal(failure.transient.retryStep, 'verifying-key', 'existing recovery route is preserved')
assert.deepEqual(actions.shift(), {
  action: 'credential_verification_failed',
  tags: {
    credential: 'ios_app_store_connect_api_key',
    attempt_id: journeyId,
    source: 'cli_verifier',
    error_category: 'apple_api_forbidden',
  },
  step: 'verifying-key',
})
assert.equal(actions.length, 0)

const order = []
const success = await runIosEffect('verifying-key', progress(), {
  carried: { p8Content: Buffer.from('PRIVATE_P8_CONTENT') },
  verifyApiKey: () => verifyIosKeyWithTelemetry(
    async () => { order.push('verified-with-apple'); return { teamId: 'SECRET_TEAM_ID' } },
    journeyId, trackAction, () => false,
  ),
  saveProgress: async (_appId, saved) => {
    assert.deepEqual(saved.completedSteps.apiKeyVerified, {
      keyId: 'SECRET_KEY_ID',
      issuerId: 'SECRET_ISSUER_ID',
    })
    order.push('saved-progress')
  },
})
assert.equal(success.next, 'verify-app')
trackVerifiedIosKey(success, journeyId, (action, tags, step) => {
  order.push('tracked-action')
  trackAction(action, tags, step)
})
assert.deepEqual(order, ['verified-with-apple', 'saved-progress', 'tracked-action'])
assert.deepEqual(actions.shift(), {
  action: 'credential_verified',
  tags: { credential: 'ios_app_store_connect_api_key', attempt_id: journeyId },
  step: 'verifying-key',
})

// A failed local save cannot turn a verified Apple response into a success event.
const saveFailure = await runIosEffect('verifying-key', progress(), {
  carried: { p8Content: Buffer.from('PRIVATE_P8_CONTENT') },
  verifyApiKey: () => verifyIosKeyWithTelemetry(
    async () => ({ teamId: 'SECRET_TEAM_ID' }), journeyId, trackAction, () => false,
  ),
  saveProgress: async () => { throw new Error('PRIVATE_SAVE_ERROR') },
})
trackVerifiedIosKey(saveFailure, journeyId, trackAction)
assert.equal(saveFailure.next, 'error')
assert.equal(actions.length, 0, 'local save failure emits neither action')

// Missing key material fails before the shared verifier is invoked.
await assert.rejects(() => runIosEffect('verifying-key', progress(), {
  readFile: async () => { throw new Error('ENOENT') },
  verifyApiKey: () => verifyIosKeyWithTelemetry(
    async () => { throw new Error('should not run') }, journeyId, trackAction, () => false,
  ),
}), /\.p8 content unavailable/)
assert.equal(actions.length, 0, 'missing file emits no action')

await assert.rejects(() => verifyIosKeyWithTelemetry(
  async () => { throw appleError }, journeyId, trackAction, () => true,
), error => error === appleError)
trackVerifiedIosKey({ next: 'verifying-key', progress: progress() }, journeyId, trackAction)
assert.equal(actions.length, 0, 'cancellation and merely opening verification emit no action')

for (const forbidden of ['SECRET_KEY_ID', 'SECRET_ISSUER_ID', 'SECRET_TEAM_ID', 'PRIVATE_P8_CONTENT', 'PRIVATE_RAW_ERROR', 'PRIVATE_SAVE_ERROR', '/secret/'])
  assert.equal(JSON.stringify(emitted).includes(forbidden), false, `action must omit ${forbidden}`)

console.log('✅ iOS credential action boundaries and safe payloads')
