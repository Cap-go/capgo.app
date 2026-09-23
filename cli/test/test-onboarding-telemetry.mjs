#!/usr/bin/env node
import assert from 'node:assert/strict'
import { trackBuilderOnboardingAction, trackBuilderOnboardingCancelled, trackBuilderOnboardingStep } from '../src/build/onboarding/telemetry.ts'


console.log('🧪 Testing onboarding telemetry...\n')

const originalFetch = globalThis.fetch

// Mock fetch so /private/config resolves (500 → silent fallback) and every
// /private/events POST is captured for assertions. Returns the captured
// requests so each case can find its own event payload.
function installFetchMock() {
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ init, url: String(url) })
    if (String(url).endsWith('/private/config'))
      return new Response('', { status: 500 })
    return new Response('{}', {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  }
  return requests
}

function findEventBody(requests) {
  const eventRequest = requests.find(request => request.url.endsWith('/private/events'))
  assert.ok(eventRequest, 'Expected a telemetry request to /private/events')
  assert.equal(eventRequest.init.method, 'POST')
  assert.equal(eventRequest.init.headers.capgkey, 'capgo-key')
  assert.equal(eventRequest.init.headers['Content-Type'], 'application/json')
  assert.equal(eventRequest.init.signal instanceof AbortSignal, true)
  const body = JSON.parse(eventRequest.init.body)
  // The shared global analytics props ride in nonPersonTags on every event.
  assert.equal(typeof body.nonPersonTags.os_release, 'string', 'global os_release tag present')
  assert.equal(typeof body.nonPersonTags.os_platform, 'string', 'global os_platform tag present')
  assert.equal(typeof body.nonPersonTags.os_arch, 'string', 'global os_arch tag present')
  assert.equal(typeof body.nonPersonTags.cli_version, 'string', 'global cli_version tag present')
  return body
}

try {
  // ── Env opt-out prevents direct onboarding telemetry sends ──────────────────
  {
    const requests = installFetchMock()
    const previousTelemetryOptOut = process.env.CAPGO_DISABLE_TELEMETRY
    process.env.CAPGO_DISABLE_TELEMETRY = 'true'
    try {
      await trackBuilderOnboardingAction({
        action: 'android_sa_method_selected',
        apikey: 'capgo-key',
        appId: 'com.example.app',
        orgId: 'org-id',
        journeyId: 'bj_journey-opt-out',
        platform: 'android',
        step: 'service-account-method-select',
      })
    }
    finally {
      if (previousTelemetryOptOut === undefined)
        delete process.env.CAPGO_DISABLE_TELEMETRY
      else
        process.env.CAPGO_DISABLE_TELEMETRY = previousTelemetryOptOut
    }
    assert.equal(requests.length, 0, 'telemetry opt-out prevents config and event requests')
    console.log('✅ Env opt-out prevents builder onboarding telemetry')
  }

  // ── Action event carries the journey id ───────────────────────────────────
  {
    const requests = installFetchMock()
    await trackBuilderOnboardingAction({
      action: 'android_sa_method_selected',
      apikey: 'capgo-key',
      appId: 'com.example.app',
      orgId: 'org-id',
      journeyId: 'bj_journey-1',
      replaySessionId: 'build-onboarding-replay-1',
      platform: 'android',
      step: 'service-account-method-select',
      tags: {
        accepted: true,
        action: 'caller_action',
        app_id: 'caller_app',
        attempt: 1,
        method: 'existing',
        platform: 'ios',
        step: 'caller-step',
      },
    })

    const body = findEventBody(requests)
    assert.equal(body.event, 'Builder Onboarding Action')
    assert.equal(body.channel, 'builder-onboarding')
    assert.equal('icon' in body, false)
    assert.equal('notify' in body, false)
    assert.equal('parser' in body, false)
    assert.equal(body.org_id, 'org-id')
    assert.equal(body.tracking_version, 2)
    assert.deepEqual(body.tags, {
      accepted: 'true',
      action: 'android_sa_method_selected',
      app_id: 'com.example.app',
      attempt: '1',
      $session_id: 'build-onboarding-replay-1',
      journey_id: 'bj_journey-1',
      method: 'existing',
      platform: 'android',
      step: 'service-account-method-select',
    })
    console.log('✅ Action event carries journey_id')
  }

  // ── Step event carries the journey id ─────────────────────────────────────
  {
    const requests = installFetchMock()
    await trackBuilderOnboardingStep({
      apikey: 'capgo-key',
      appId: 'com.example.app',
      orgId: 'org-id',
      journeyId: 'bj_journey-2',
      replaySessionId: 'build-onboarding-replay-2',
      platform: 'ios',
      step: 'api-key-instructions',
      durationMs: 1234,
      durationStep: 'welcome',
    })

    const body = findEventBody(requests)
    assert.equal(body.event, 'Builder Onboarding Step')
    assert.equal(body.channel, 'builder-onboarding')
    assert.deepEqual(body.tags, {
      $session_id: 'build-onboarding-replay-2',
      app_id: 'com.example.app',
      duration_ms: '1234',
      duration_step: 'welcome',
      journey_id: 'bj_journey-2',
      platform: 'ios',
      step: 'api-key-instructions',
    })
    console.log('✅ Step event carries journey_id')
  }

  // ── Quit event: full payload (platform + last step + duration) ─────────────
  {
    const requests = installFetchMock()
    await trackBuilderOnboardingCancelled({
      apikey: 'capgo-key',
      appId: 'com.example.app',
      orgId: 'org-id',
      journeyId: 'bj_journey-3',
      replaySessionId: 'build-onboarding-replay-3',
      platform: 'ios',
      lastStep: 'verifying-key',
      durationMs: 9876.4,
    })

    const body = findEventBody(requests)
    assert.equal(body.event, 'Builder Onboarding Quit')
    assert.equal(body.channel, 'builder-onboarding')
    assert.equal('icon' in body, false)
    assert.equal('notify' in body, false)
    assert.equal('parser' in body, false)
    assert.equal(body.org_id, 'org-id')
    assert.equal(body.tracking_version, 2)
    assert.deepEqual(body.tags, {
      $session_id: 'build-onboarding-replay-3',
      app_id: 'com.example.app',
      duration_ms: '9876', // rounded
      journey_id: 'bj_journey-3',
      last_step: 'verifying-key',
      platform: 'ios',
    })
    console.log('✅ Quit event carries journey_id, last_step, duration_ms, platform')
  }

  // ── Quit event: minimal payload (quit before choosing a platform) ──────────
  {
    const requests = installFetchMock()
    await trackBuilderOnboardingCancelled({
      apikey: 'capgo-key',
      appId: 'com.example.app',
      journeyId: 'bj_journey-4',
      // no platform, no lastStep, no orgId, no durationMs
    })

    const body = findEventBody(requests)
    assert.equal(body.event, 'Builder Onboarding Quit')
    assert.equal(body.org_id, undefined)
    // Only the always-present tags survive; the optional dimensions are omitted
    // rather than sent as empty/undefined strings.
    assert.deepEqual(body.tags, {
      app_id: 'com.example.app',
      journey_id: 'bj_journey-4',
    })
    console.log('✅ Quit event omits optional dimensions when quitting pre-platform')
  }

  console.log('\n✅ Onboarding telemetry tests passed')
}
finally {
  globalThis.fetch = originalFetch
}
