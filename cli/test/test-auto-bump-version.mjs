#!/usr/bin/env node
/**
 * Unit tests for autoBumpVersion (patch) and autoBumpMinorVersion (minor)
 */

import { autoBumpMinorVersion, autoBumpVersion } from '../src/versionHelpers.ts'

let passed = 0
let failed = 0

function assertEqual(actual, expected, label) {
  if (actual === expected) {
    console.log(`   ✓ ${label}: ${actual}`)
    passed++
  }
  else {
    console.error(`   ❌ ${label}: expected ${expected}, got ${actual}`)
    failed++
  }
}

console.log('🧪 Testing autoBumpVersion / autoBumpMinorVersion...\n')

console.log('1️⃣  Patch bump (autoBumpVersion)...')
assertEqual(autoBumpVersion('1.0.0'), '1.0.1', '1.0.0 → patch')
assertEqual(autoBumpVersion('0.0.9'), '0.0.10', '0.0.9 → patch')
assertEqual(autoBumpVersion('2.3.4'), '2.3.5', '2.3.4 → patch')

console.log('\n2️⃣  Minor bump (autoBumpMinorVersion)...')
assertEqual(autoBumpMinorVersion('1.0.0'), '1.1.0', '1.0.0 → minor')
assertEqual(autoBumpMinorVersion('0.0.9'), '0.1.0', '0.0.9 → minor')
assertEqual(autoBumpMinorVersion('2.3.4'), '2.4.0', '2.3.4 → minor')
assertEqual(autoBumpMinorVersion('1.9.0'), '1.10.0', '1.9.0 → minor')
assertEqual(autoBumpMinorVersion('0.1.0'), '0.2.0', '0.1.0 → minor')

console.log('\n3️⃣  Chained minor bumps (free-slot walk)...')
let v = '0.0.9'
v = autoBumpMinorVersion(v)
assertEqual(v, '0.1.0', 'first minor from 0.0.9')
v = autoBumpMinorVersion(v)
assertEqual(v, '0.2.0', 'second minor')
v = autoBumpMinorVersion(v)
assertEqual(v, '0.3.0', 'third minor')

console.log('\n4️⃣  Fallback for non-strict semver-like strings...')
assertEqual(autoBumpMinorVersion('3.2.1-beta'), '3.3.0', 'prerelease base → minor via @std/semver or fallback')

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log(`📊 Test Results: ${passed} passed, ${failed} failed`)
if (failed > 0)
  process.exit(1)
console.log('✅ All auto-bump version tests passed')
