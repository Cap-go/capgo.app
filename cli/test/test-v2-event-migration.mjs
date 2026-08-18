#!/usr/bin/env node
import assert from 'node:assert/strict'
import { sendCliEvent } from '../src/app/debug.ts'

console.log('🧪 Testing v2 event migration (sendCliEvent → onboarding events)...\n')

const originalFetch = globalThis.fetch

try {
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

  // sendCliEvent is the shared helper behind every onboarding-step-* / debug event.
  await sendCliEvent('onboarding-v2', 'org-123', 'capgo-key', 'onboarding-step-done', 'com.example.app')

  const eventRequest = requests.find(request => request.url.endsWith('/private/events'))
  assert.ok(eventRequest, 'Expected sendCliEvent telemetry request')
  assert.equal(eventRequest.init.method, 'POST')
  assert.equal(eventRequest.init.headers.capgkey, 'capgo-key')

  const body = JSON.parse(eventRequest.init.body)
  assert.equal(body.event, 'onboarding-step-done')
  assert.equal(body.channel, 'onboarding-v2')
  assert.equal('icon' in body, false)
  assert.equal('notify' in body, false)
  assert.equal('parser' in body, false)
  assert.equal(body.org_id, 'org-123', 'org is now sent as org_id (not user_id)')
  assert.equal(body.tracking_version, 2, 'event opts into the v2 actor-scoped contract')
  assert.equal(body.user_id, undefined, 'CLI must not send user_id (backend derives the actor from the key)')
  // Global analytics props now ride in nonPersonTags (event-only; the backend
  // never writes them as PostHog person properties / $set). Caller tags stay in
  // tags — sendCliEvent's direct (non-trackEvent) send path included.
  assert.equal(typeof body.nonPersonTags.os_release, 'string', 'OS release rides on the shared send path')
  assert.equal(typeof body.nonPersonTags.os_platform, 'string')
  assert.equal(typeof body.nonPersonTags.os_arch, 'string')
  assert.equal(typeof body.nonPersonTags.timezone, 'string')
  assert.equal(typeof body.nonPersonTags.cli_version, 'string')
  assert.deepEqual(body.tags, { 'app-id': 'com.example.app' })

  console.log('✅ v2 event migration tests passed')
}
finally {
  globalThis.fetch = originalFetch
}
