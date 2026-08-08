#!/usr/bin/env node

import process from 'node:process'
import { shouldWarnTrialExpiry } from '../src/utils.ts'

console.log('🧪 Testing trial expiry warning gate...\n')

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

function assertEquals(actual, expected, message) {
  if (actual !== expected)
    throw new Error(message || `Expected ${expected}, got ${actual}`)
}

await test('warns for unpaid trial without credits', () => {
  assertEquals(shouldWarnTrialExpiry({
    trialDays: 5,
    isPaying: false,
    hasCredits: false,
  }), true)
})

await test('does not warn when org has usage credits and no plan', () => {
  assertEquals(shouldWarnTrialExpiry({
    trialDays: 5,
    isPaying: false,
    hasCredits: true,
  }), false)
})

await test('does not warn when org is paying', () => {
  assertEquals(shouldWarnTrialExpiry({
    trialDays: 5,
    isPaying: true,
    hasCredits: false,
  }), false)
})

await test('does not warn when trial already ended', () => {
  assertEquals(shouldWarnTrialExpiry({
    trialDays: 0,
    isPaying: false,
    hasCredits: false,
  }), false)
})

await test('does not warn when warning flag is false', () => {
  assertEquals(shouldWarnTrialExpiry({
    trialDays: 5,
    isPaying: false,
    hasCredits: false,
    warning: false,
  }), false)
})

console.log(`\n📊 Results: ${testsPassed} passed, ${testsFailed} failed`)
if (testsFailed > 0)
  process.exit(1)
