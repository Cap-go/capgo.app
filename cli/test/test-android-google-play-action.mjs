#!/usr/bin/env node
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { runAndroidEffect } from '../src/build/onboarding/android/flow.ts'
import {
  trackConnectedGooglePlay,
  trackGeneratedGooglePlayProvisioningFailure,
  trackGooglePlayConnectionFailure,
  trackImportedGooglePlayValidationFailure,
  trackUnverifiedGooglePlayConnection,
} from '../src/build/onboarding/android/ui/google-play-action.ts'

const journeyId = 'bj_google_play_test'
const actions = []
const allActions = []
const trackAction = (action, tags, step) => {
  const event = { action, tags, step }
  actions.push(event)
  allActions.push(event)
}

const importedProgress = {
  appId: 'com.example.googleplay',
  platform: 'android',
  startedAt: '2026-01-01T00:00:00.000Z',
  serviceAccountMethod: 'existing',
  serviceAccountJsonPath: '/private/customer-service-account.json',
  completedSteps: {
    androidPackageChosen: { packageName: 'com.private.customer' },
  },
}

// Verified imports report success only after the engine's progress save returns.
const importOrder = []
const imported = await runAndroidEffect('sa-json-validating', importedProgress, {
  readFile: async () => Buffer.from(JSON.stringify({
    client_email: 'private-customer@example.iam.gserviceaccount.com',
    private_key: 'PRIVATE_SERVICE_ACCOUNT_KEY',
    project_id: 'private-project-id',
  })),
  validateServiceAccountJson: async () => ({
    ok: true,
    serviceAccountEmail: 'private-customer@example.iam.gserviceaccount.com',
    projectId: 'private-project-id',
  }),
  saveAndroidProgress: async (_appId, saved) => {
    assert.ok(saved._serviceAccountKeyBase64)
    assert.equal(saved.serviceAccountValidationSkipped, false)
    importOrder.push('saved-progress')
  },
})
const reportedImportSuccesses = new Set()
trackConnectedGooglePlay(imported.progress, 'imported_service_account', journeyId, (...args) => {
  importOrder.push('tracked-action')
  trackAction(...args)
}, reportedImportSuccesses)
trackConnectedGooglePlay(imported.progress, 'imported_service_account', journeyId, trackAction, reportedImportSuccesses)
assert.deepEqual(importOrder, ['saved-progress', 'tracked-action'])
assert.deepEqual(actions.splice(0), [{
  action: 'google_play_connected',
  tags: {
    attempt_id: journeyId,
    source: 'imported_service_account',
  },
  step: 'sa-json-validating',
}])

// Every validation failure is mapped to a stable, non-sensitive reason.
for (const [kind, reason] of [
  ['file-read-error', 'file_read_error'],
  ['shape-error', 'shape_error'],
  ['token-error', 'token_error'],
  ['no-app-access', 'no_app_access'],
  ['network-error', 'network_error'],
]) {
  trackImportedGooglePlayValidationFailure(kind, journeyId, trackAction)
  assert.deepEqual(actions.pop(), {
    action: 'google_play_connection_failed',
    tags: {
      attempt_id: journeyId,
      source: 'imported_service_account',
      reason,
    },
    step: 'sa-json-validating',
  })
}

// Save-anyway is explicitly unverified and can never satisfy verified success.
const skippedProgress = {
  ...imported.progress,
  serviceAccountValidationSkipped: true,
}
assert.equal(trackConnectedGooglePlay(
  skippedProgress,
  'imported_service_account',
  journeyId,
  trackAction,
  new Set(),
), false)
trackUnverifiedGooglePlayConnection(journeyId, trackAction)
assert.deepEqual(actions.splice(0), [{
  action: 'google_play_connection_unverified',
  tags: {
    attempt_id: journeyId,
    source: 'imported_service_account',
    reason: 'validation_skipped',
  },
  step: 'sa-json-validation-failed',
}])

const generatedProgress = {
  appId: 'com.example.googleplay',
  platform: 'android',
  startedAt: '2026-01-01T00:00:00.000Z',
  serviceAccountMethod: 'generate',
  _serviceAccountKeyBase64: 'PRIVATE_GENERATED_SERVICE_ACCOUNT_JSON',
  completedSteps: {
    serviceAccountProvisioned: {
      email: 'private-generated@example.iam.gserviceaccount.com',
      projectId: 'private-generated-project',
      uniqueId: 'private-unique-id',
    },
    playInviteProvisioned: {
      developerId: 'private-developer-id',
      serviceAccountEmail: 'private-generated@example.iam.gserviceaccount.com',
    },
  },
}

// Generated success requires the key plus both durable provisioning markers.
for (const incomplete of [
  { ...generatedProgress, _serviceAccountKeyBase64: undefined },
  { ...generatedProgress, completedSteps: { ...generatedProgress.completedSteps, serviceAccountProvisioned: undefined } },
  { ...generatedProgress, completedSteps: { ...generatedProgress.completedSteps, playInviteProvisioned: undefined } },
]) {
  assert.equal(trackConnectedGooglePlay(
    incomplete,
    'generated_service_account',
    journeyId,
    trackAction,
    new Set(),
  ), false)
}
assert.equal(actions.length, 0)

const reportedGeneratedSuccesses = new Set()
assert.equal(trackConnectedGooglePlay(
  generatedProgress,
  'generated_service_account',
  journeyId,
  trackAction,
  reportedGeneratedSuccesses,
), true)
assert.equal(trackConnectedGooglePlay(
  generatedProgress,
  'generated_service_account',
  journeyId,
  trackAction,
  reportedGeneratedSuccesses,
), true)
assert.deepEqual(actions.splice(0), [{
  action: 'google_play_connected',
  tags: {
    attempt_id: journeyId,
    source: 'generated_service_account',
  },
  step: 'gcp-setup-running',
}])

// A late throw cannot replace already-durable success with a failure.
assert.equal(trackGeneratedGooglePlayProvisioningFailure(
  generatedProgress,
  journeyId,
  trackAction,
  new Set(),
), true)
assert.deepEqual(actions.splice(0).map(event => event.action), ['google_play_connected'])

assert.equal(trackGeneratedGooglePlayProvisioningFailure(
  { ...generatedProgress, completedSteps: {} },
  journeyId,
  trackAction,
  new Set(),
), false)
assert.deepEqual(actions.splice(0), [{
  action: 'google_play_connection_failed',
  tags: {
    attempt_id: journeyId,
    source: 'generated_service_account',
    reason: 'provisioning_failed',
  },
  step: 'gcp-setup-running',
}])

// OAuth outcomes use stable reasons, and genuine retry failures are not deduped.
trackGooglePlayConnectionFailure(
  'generated_service_account',
  'missing_scopes',
  'google-sign-in-running',
  journeyId,
  trackAction,
)
trackGooglePlayConnectionFailure(
  'generated_service_account',
  'oauth_failed',
  'google-sign-in-running',
  journeyId,
  trackAction,
)
trackGooglePlayConnectionFailure(
  'generated_service_account',
  'oauth_failed',
  'google-sign-in-running',
  journeyId,
  trackAction,
)
assert.deepEqual(actions.map(event => event.tags.reason), ['missing_scopes', 'oauth_failed', 'oauth_failed'])

const safeEvents = JSON.stringify(allActions)
for (const sensitive of [
  'PRIVATE_SERVICE_ACCOUNT_KEY',
  'PRIVATE_GENERATED_SERVICE_ACCOUNT_JSON',
  'private-customer@example.iam.gserviceaccount.com',
  'private-generated@example.iam.gserviceaccount.com',
  'private-project-id',
  'private-generated-project',
  'private-developer-id',
  'com.private.customer',
  '/private/customer-service-account.json',
]) {
  assert.equal(safeEvents.includes(sensitive), false, `telemetry leaked ${sensitive}`)
}
actions.length = 0

// Even a synchronous telemetry implementation failure cannot break onboarding.
const throwingTrackAction = () => { throw new Error('telemetry unavailable') }
assert.doesNotThrow(() => trackConnectedGooglePlay(
  generatedProgress,
  'generated_service_account',
  journeyId,
  throwingTrackAction,
  new Set(),
))
assert.doesNotThrow(() => trackGooglePlayConnectionFailure(
  'generated_service_account',
  'oauth_failed',
  'google-sign-in-running',
  journeyId,
  throwingTrackAction,
))
assert.doesNotThrow(() => trackUnverifiedGooglePlayConnection(journeyId, throwingTrackAction))

console.log('✅ Android Google Play actions follow durable progress and use safe tags')
