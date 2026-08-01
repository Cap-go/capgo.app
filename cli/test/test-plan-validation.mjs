#!/usr/bin/env node

import process from 'node:process'
import * as utils from '../src/utils.ts'

console.log('🧪 Testing app-aware plan validation...\n')

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

function assert(condition, message) {
  if (!condition)
    throw new Error(message)
}

function assertEquals(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

await test('checks an app-scoped key through the app-aware plan RPC', async () => {
  assert(typeof utils.isAllowedActionForApp === 'function', 'Expected isAllowedActionForApp to be exported')

  const calls = []
  const supabase = {
    rpc: async (name, args) => {
      calls.push({ name, args })
      return { data: true, error: null }
    },
  }

  const allowed = await utils.isAllowedActionForApp(
    supabase,
    'org-id',
    'com.example.app',
  )

  assertEquals(allowed, true)
  assertEquals(calls, [{
    name: 'is_allowed_action_org_action',
    args: {
      orgid: 'org-id',
      appid: 'com.example.app',
      actions: ['mau', 'storage', 'bandwidth', 'build_time'],
    },
  }])
})

await test('surfaces plan RPC errors instead of reporting an invalid plan', async () => {
  assert(typeof utils.isAllowedActionForApp === 'function', 'Expected isAllowedActionForApp to be exported')

  const supabase = {
    rpc: async () => ({
      data: null,
      error: { message: 'permission lookup failed' },
    }),
  }

  let thrown
  try {
    await utils.isAllowedActionForApp(supabase, 'org-id', 'com.example.app')
  }
  catch (error) {
    thrown = error
  }

  assert(thrown instanceof Error, 'Expected the RPC error to be thrown')
  assert(thrown.message.includes('Cannot validate plan'), `Unexpected error: ${thrown.message}`)
})

console.log(`\n📊 Results: ${testsPassed} passed, ${testsFailed} failed`)
if (testsFailed > 0)
  process.exit(1)
