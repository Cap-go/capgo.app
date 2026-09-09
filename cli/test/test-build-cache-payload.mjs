#!/usr/bin/env node

console.log('🧪 Testing build job cache payload...\n')

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

function assertDeepEquals(actual, expected, message) {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    throw new Error(message || `Expected ${expectedJson}, got ${actualJson}`)
  }
}

const { buildJobCachePayload } = await import('../src/build/request.ts')

await test('buildJobCachePayload omits cache fields by default', () => {
  assertDeepEquals(buildJobCachePayload(), {})
  assertDeepEquals(buildJobCachePayload(undefined), {})
  assertDeepEquals(buildJobCachePayload({ cache: true }), {})
})

await test('buildJobCachePayload sends cache_enabled false when opted out', () => {
  assertDeepEquals(buildJobCachePayload({ cache: false }), { cache_enabled: false })
})

await test('buildJobCachePayload sends cache_key and cache_fingerprint_extra when set', () => {
  assertDeepEquals(buildJobCachePayload({ cacheKey: 'prod' }), {
    cache_key: 'prod',
    cache_fingerprint_extra: 'prod',
  })
  assertDeepEquals(buildJobCachePayload({ cacheKey: '  rc  ' }), {
    cache_key: 'rc',
    cache_fingerprint_extra: 'rc',
  })
})

await test('buildJobCachePayload omits cache_key when blank', () => {
  assertDeepEquals(buildJobCachePayload({ cacheKey: '   ' }), {})
})

await test('buildJobCachePayload can combine no-cache with cache_key (cache_key ignored by builder when disabled)', () => {
  assertDeepEquals(buildJobCachePayload({ cache: false, cacheKey: 'prod' }), {
    cache_enabled: false,
    cache_key: 'prod',
    cache_fingerprint_extra: 'prod',
  })
})

console.log(`\n${testsPassed} passed, ${testsFailed} failed`)
if (testsFailed > 0)
  process.exit(1)
