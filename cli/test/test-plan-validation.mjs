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
  assert(typeof utils.isAllowedPlanActions === 'function', 'Expected isAllowedPlanActions to be exported')

  const calls = []
  const supabase = {
    rpc: async (name, args) => {
      calls.push({ name, args })
      return { data: true, error: null }
    },
  }

  const allowed = await utils.isAllowedPlanActions(
    supabase,
    'org-id',
    ['mau', 'storage', 'bandwidth', 'build_time'],
    'com.example.app',
  )

  assertEquals(allowed, true)
  assertEquals(calls, [{
    name: 'is_allowed_action_org_action',
    args: {
      orgid: 'org-id',
      actions: ['mau', 'storage', 'bandwidth', 'build_time'],
      appid: 'com.example.app',
    },
  }])
})

await test('surfaces plan RPC errors instead of reporting an invalid plan', async () => {
  assert(typeof utils.isAllowedPlanActions === 'function', 'Expected isAllowedPlanActions to be exported')

  const supabase = {
    rpc: async () => ({
      data: null,
      error: { message: 'permission lookup failed' },
    }),
  }

  let thrown
  try {
    await utils.isAllowedPlanActions(supabase, 'org-id', ['storage'], 'com.example.app')
  }
  catch (error) {
    thrown = error
  }

  assert(thrown instanceof Error, 'Expected the RPC error to be thrown')
  assert(thrown.message.includes('Cannot validate plan'), `Unexpected error: ${thrown.message}`)
})

await test('surfaces organization plan RPC errors instead of reporting an invalid plan', async () => {
  const supabase = {
    rpc: () => ({
      single: async () => ({
        data: null,
        error: { message: 'organization lookup failed' },
      }),
    }),
  }

  let thrown
  try {
    await utils.isAllowedActionOrg(supabase, 'org-id')
  }
  catch (error) {
    thrown = error
  }

  assert(thrown instanceof Error, 'Expected the organization RPC error to be thrown')
  assert(thrown.message.includes('Cannot validate plan'), `Unexpected error: ${thrown.message}`)
})

console.log(`\n📊 Results: ${testsPassed} passed, ${testsFailed} failed`)
if (testsFailed > 0)
  process.exit(1)
