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

await test('buildJobCachePayload omits cache_enabled by default', () => {
  assertDeepEquals(buildJobCachePayload(), {})
  assertDeepEquals(buildJobCachePayload(undefined), {})
  assertDeepEquals(buildJobCachePayload(true), {})
})

await test('buildJobCachePayload sends cache_enabled false when opted out', () => {
  assertDeepEquals(buildJobCachePayload(false), { cache_enabled: false })
})

console.log(`\n${testsPassed} passed, ${testsFailed} failed`)
if (testsFailed > 0)
  process.exit(1)
