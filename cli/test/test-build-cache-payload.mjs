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

const { buildJobCachePayload, shouldLogFailedBuildCacheHint } = await import('../src/build/request.ts')

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

await test('shouldLogFailedBuildCacheHint is on for default CLI builds', () => {
  if (!shouldLogFailedBuildCacheHint({}))
    throw new Error('default CLI failure should show the cache tip')
  if (!shouldLogFailedBuildCacheHint({ aiAnalysisMode: 'auto-prompt' }))
    throw new Error('auto-prompt CLI failure should show the cache tip')
  if (!shouldLogFailedBuildCacheHint({ aiAnalysisMode: 'skip' }))
    throw new Error('skip-AI CLI failure should still show the cache tip')
})

await test('shouldLogFailedBuildCacheHint is off for onboarding TUI caller-handled mode', () => {
  if (shouldLogFailedBuildCacheHint({ aiAnalysisMode: 'caller-handled' }))
    throw new Error('TUI caller-handled mode must not stream the cache tip into build-log-view')
})

await test('shouldLogFailedBuildCacheHint is off when cache is already isolated or disabled', () => {
  if (shouldLogFailedBuildCacheHint({ cache: false }))
    throw new Error('no-cache builds should not show the cache tip')
  if (shouldLogFailedBuildCacheHint({ cacheKey: 'prod' }))
    throw new Error('cache-key builds should not show the cache tip')
  if (!shouldLogFailedBuildCacheHint({ cacheKey: '  ' }))
    throw new Error('blank cache-key should still show the cache tip')
})

console.log(`\n${testsPassed} passed, ${testsFailed} failed`)
if (testsFailed > 0)
  process.exit(1)
