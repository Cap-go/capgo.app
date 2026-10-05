#!/usr/bin/env node
import assert from 'node:assert/strict'
import { resolveConfiguredOrganizationUpdateApiHost, resolveOrganizationUpdateApiHost } from '../src/organization/set.ts'
import { invokeCapgoCliApi, normalizeSupabaseHost } from '../src/utils.ts'

assert.equal(normalizeSupabaseHost('http://localhost:54321/'), 'http://localhost:54321')
assert.throws(
  () => normalizeSupabaseHost('http://self-hosted.example.com'),
  /must use HTTPS/,
)

assert.equal(
  await resolveOrganizationUpdateApiHost({
    supaHost: 'https://self-hosted.example.com///',
    supaAnon: 'anon-key',
  }, true),
  'https://self-hosted.example.com/functions/v1',
)

assert.equal(
  await resolveOrganizationUpdateApiHost({
    supaHost: 'https://example.com/custom/supabase/',
    supaAnon: 'anon-key',
  }, true),
  'https://example.com/custom/supabase/functions/v1',
)

await assert.rejects(
  () => resolveOrganizationUpdateApiHost({
    supaHost: 'https://example.com/supabase?env=dev',
    supaAnon: 'anon-key',
  }, true),
  /query parameters or fragments/,
)

assert.equal(
  resolveConfiguredOrganizationUpdateApiHost({
    hostApi: 'https://api.capgo.app',
    supaHost: 'https://configured.example.com/',
    supaKey: 'anon-key',
  }),
  'https://configured.example.com/functions/v1',
)

assert.equal(
  resolveConfiguredOrganizationUpdateApiHost({
    hostApi: 'https://configured-api.example.com/functions/v1',
    supaHost: 'https://configured.example.com/',
    supaKey: 'anon-key',
  }),
  'https://configured-api.example.com/functions/v1',
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
    supaHost: 'https://self-hosted.example.com',
    supaAnon: 'test-anon-key',
  })
  assert.equal(result.error, null)
  assert.equal(request.url, 'https://self-hosted.example.com/functions/v1/app/com.example.app')
  assert.equal(request.init.redirect, 'error')
}
finally {
  globalThis.fetch = originalFetch
}

console.log('organization set API host tests passed')
