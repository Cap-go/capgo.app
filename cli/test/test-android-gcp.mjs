#!/usr/bin/env node
/**
 * Unit tests for the GCP API helpers that don't require a network round-trip.
 * Live API calls are covered by manual end-to-end testing.
 */

console.log('🧪 Testing GCP helpers...\n')

let testsPassed = 0
let testsFailed = 0

async function test(name, fn) {
  try {
    console.log(`\n🔍 ${name}`)
    await fn()
    console.log(`✅ PASSED: ${name}`)
    testsPassed++
  }
  catch (error) {
    console.error(`❌ FAILED: ${name}`)
    console.error(`   Error: ${error.message}`)
    testsFailed++
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed') }
function assertEquals(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${b}, got ${a}`) }

async function importGcp() {
  return await import('../src/build/onboarding/android/gcp-api.ts')
}

await test('generateProjectId respects 30-char max', async () => {
  const { generateProjectId } = await importGcp()
  const cases = [
    'com.example.app',
    'com.capgo.tutorial.really.long.name.that.goes.on.and.on',
    'short',
    'a',
    'ABC.def.GHI',
  ]
  for (const appId of cases) {
    const id = generateProjectId(appId)
    assert(id.length >= 6 && id.length <= 30, `${appId} -> ${id} (length ${id.length})`)
    assert(/^[a-z][a-z0-9-]*[a-z0-9]$/.test(id), `${id} must match GCP project ID regex (starts with letter, no trailing hyphen, lowercase alphanum + hyphens)`)
    assert(id.startsWith('capgo-'), `${id} should start with capgo-`)
  }
})

await test('generateProjectId is unique across invocations', async () => {
  const { generateProjectId } = await importGcp()
  const seen = new Set()
  for (let i = 0; i < 20; i++) {
    const id = generateProjectId('com.example.app')
    assert(!seen.has(id), `duplicate project ID on iteration ${i}: ${id}`)
    seen.add(id)
  }
})

await test('generateProjectId avoids ambiguous chars (no 0, 1, l, o) in suffix', async () => {
  const { generateProjectId } = await importGcp()
  const id = generateProjectId('com.example.app')
  const suffix = id.slice(-6)
  assert(!/[01lo]/.test(suffix), `suffix "${suffix}" must avoid ambiguous chars 0/1/l/o`)
})

await test('generateProjectId handles empty-slug fallback', async () => {
  const { generateProjectId } = await importGcp()
  // Input that slugifies to empty (only punctuation)
  const id = generateProjectId('...')
  assert(id.length >= 6 && id.length <= 30, `fallback id length out of range: ${id}`)
  assert(id.startsWith('capgo-'), `fallback id should still start with capgo-`)
})

await test('ANDROIDPUBLISHER_API + default SA constants match docs', async () => {
  const mod = await importGcp()
  assertEquals(mod.ANDROIDPUBLISHER_API, 'androidpublisher.googleapis.com')
  assertEquals(mod.DEFAULT_SERVICE_ACCOUNT_ID, 'capgo-native-build')
  assert(mod.DEFAULT_SERVICE_ACCOUNT_DISPLAY_NAME.length > 0)
  assert(mod.DEFAULT_SERVICE_ACCOUNT_DESCRIPTION.length > 0)
})

// Regression test for the `noop.DONE_OPERATION` bug — Service Usage returns
// this synthetic name when enable-API is called on an already-enabled service.
// The CLI must not try to poll it; we test the behavior by shimming `fetch`.
await test('enableService short-circuits on noop.DONE_OPERATION without polling', async () => {
  const { enableService } = await importGcp()
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET' })
    if (init?.method === 'POST' && String(url).includes(':enable')) {
      return new Response(JSON.stringify({
        name: 'operations/noop.DONE_OPERATION',
        done: true,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`unexpected fetch to ${url}`)
  }
  try {
    await enableService('fake-token', 'my-project-123', 'androidpublisher.googleapis.com')
  }
  finally {
    globalThis.fetch = originalFetch
  }
  assertEquals(calls.length, 1, `expected exactly one fetch call, got ${calls.length} (polling ran when it shouldn't)`)
  assert(calls[0].url.includes(':enable'), 'the single call should be the enable POST')
})

await test('sanitizeGcpProjectDisplayName strips em-dash + invalid chars', async () => {
  const { sanitizeGcpProjectDisplayName } = await importGcp()
  assertEquals(sanitizeGcpProjectDisplayName('Capgo Native Build — com.example.app'), 'Capgo Native Build com example')
  assertEquals(sanitizeGcpProjectDisplayName('foo_bar_baz'), 'foo bar baz')
  assertEquals(sanitizeGcpProjectDisplayName('_leading and trailing_'), 'leading and trailing')
})

await test('sanitizeGcpProjectDisplayName strips periods from appIds (GCP rejects dots)', async () => {
  const { sanitizeGcpProjectDisplayName } = await importGcp()
  const out = sanitizeGcpProjectDisplayName('Capgo Native Build com.spotties.spotties')
  assert(!out.includes('.'), `display name must not contain periods, got "${out}"`)
  assert(out.length >= 4 && out.length <= 30, `expected 4–30 chars, got ${out.length}: "${out}"`)
  assert(/^[A-Za-z0-9]/.test(out), `must start with letter/digit, got "${out}"`)
  assert(/[A-Za-z0-9]$/.test(out), `must end with letter/digit, got "${out}"`)
  assertEquals(
    sanitizeGcpProjectDisplayName('Capgo Native Build com.example.app'),
    'Capgo Native Build com example',
  )
})

await test('sanitizeGcpProjectDisplayName respects 30-char max + start/end rules', async () => {
  const { sanitizeGcpProjectDisplayName } = await importGcp()
  const long = 'Capgo Native Build com.very.long.app.name'
  const out = sanitizeGcpProjectDisplayName(long)
  assert(!out.includes('.'), `display name must not contain periods, got "${out}"`)
  assert(out.length <= 30, `expected ≤30 chars, got ${out.length}`)
  assert(/^[A-Za-z0-9]/.test(out), `must start with letter/digit, got "${out}"`)
  assert(/[A-Za-z0-9]$/.test(out), `must end with letter/digit, got "${out}"`)
})

await test('sanitizeGcpProjectDisplayName falls back when input is too short', async () => {
  const { sanitizeGcpProjectDisplayName } = await importGcp()
  assertEquals(sanitizeGcpProjectDisplayName(''), 'Capgo Build')
  assertEquals(sanitizeGcpProjectDisplayName('—_!'), 'Capgo Build')
  assertEquals(sanitizeGcpProjectDisplayName('ab'), 'Capgo Build')
})

await test('enableService surfaces API-level errors in the initial response', async () => {
  const { enableService } = await importGcp()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    name: 'operations/something',
    done: true,
    error: { code: 7, message: 'PERMISSION_DENIED' },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  let threw = false
  try {
    await enableService('fake-token', 'my-project-123', 'androidpublisher.googleapis.com')
  }
  catch (err) {
    threw = true
    assert(/PERMISSION_DENIED/.test(err.message), `expected PERMISSION_DENIED in error, got: ${err.message}`)
  }
  finally {
    globalThis.fetch = originalFetch
  }
  assert(threw, 'expected enableService to throw on operation.error')
})

console.log(`\n📊 Results: ${testsPassed} passed, ${testsFailed} failed`)
if (testsFailed > 0)
  process.exit(1)
