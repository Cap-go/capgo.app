#!/usr/bin/env node
import assert from 'node:assert/strict'
import { resolveOrganizationUpdateApiHost } from '../src/organization/set.ts'
import { invokeCapgoCliApi, normalizeCapgoApiHost, normalizeCapgoHostOptions, normalizeSupabaseHost } from '../src/utils.ts'

assert.equal(normalizeSupabaseHost('http://localhost:54321/'), 'http://localhost:54321')
assert.throws(
  () => normalizeSupabaseHost('http://self-hosted.example.com'),
  /must use HTTPS/,
)
assert.throws(() => normalizeCapgoApiHost('https://example.com/api?env=dev'), /query parameters or fragments/)

assert.equal(
  await resolveOrganizationUpdateApiHost({ apiHost: 'https://self-hosted.example.com/functions/v1///' }, true),
  'https://self-hosted.example.com/functions/v1',
)

// Deprecated --supa-host keeps its path and maps to its Edge Functions.
assert.equal(
  await resolveOrganizationUpdateApiHost(normalizeCapgoHostOptions({
    supaHost: 'https://example.com/custom/supabase/',
    supaAnon: 'anon-key',
  }, true), true),
  'https://example.com/custom/supabase/functions/v1',
)

assert.throws(
  () => normalizeCapgoHostOptions({ supaHost: 'https://example.com/supabase?env=dev' }, true),
  /query parameters or fragments/,
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
  assert.equal(request.init.redirect, 'error')
  assert.equal(request.init.headers.Authorization, 'test-api-key', 'no Supabase anon key: the API key is the credential')
  assert.equal(request.init.headers.capgo_api, '2025-10-01')
}
finally {
  globalThis.fetch = originalFetch
}

console.log('organization set API host tests passed')
