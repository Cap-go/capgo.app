#!/usr/bin/env node
import assert from 'node:assert/strict'
import { resolveOrganizationUpdateApiHost } from '../src/organization/set.ts'
import { invokeCapgoCliApi, normalizeCapgoApiHost } from '../src/utils.ts'

assert.equal(normalizeCapgoApiHost('http://localhost:54321/'), 'http://localhost:54321')
assert.throws(
  () => normalizeCapgoApiHost('http://self-hosted.example.com'),
  /HTTPS/,
)
assert.throws(() => normalizeCapgoApiHost('https://example.com/api?env=dev'), /query parameters or fragments/)

assert.equal(
  await resolveOrganizationUpdateApiHost({ apiHost: 'https://self-hosted.example.com/functions/v1///' }, true),
  'https://self-hosted.example.com/functions/v1',
)

const originalFetch = globalThis.fetch
let request
try {
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init }
    return Response.json({ ok: true })
  }
  const result = await invokeCapgoCliApi('app/com.example.app', {
    apikey: 'test-api-key',
    method: 'GET',
    apiHost: 'https://self-hosted.example.com/functions/v1',
  })
  assert.equal(result.error, null)
  assert.equal(request.url, 'https://self-hosted.example.com/functions/v1/app/com.example.app')
  assert.equal(request.init.redirect, 'manual')
  assert.equal(request.init.headers.Authorization, 'test-api-key', 'no Supabase anon key: the API key is the credential')
  assert.equal(request.init.headers.capgo_api, '2025-10-01')

  // Redirects are not followed: a 3xx comes back as an error, without a second request.
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example.com/' } })
  }
  const redirected = await invokeCapgoCliApi('app/com.example.app', {
    apikey: 'test-api-key',
    method: 'GET',
    apiHost: 'https://self-hosted.example.com/functions/v1',
  })
  assert.equal(redirected.data, null)
  assert.ok(redirected.error)
  assert.equal(calls, 1)
}
finally {
  globalThis.fetch = originalFetch
}

console.log('organization set API host tests passed')
