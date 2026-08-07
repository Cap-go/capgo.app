#!/usr/bin/env node
/**
 * Unit tests for autoBumpVersionBy / autoBumpVersion / autoBumpMinorVersion
 */

import {
  autoBumpMinorVersion,
  autoBumpVersion,
  autoBumpVersionBy,
  normalizeAutoBumpInput,
  normalizeAutoBumpLevel,
} from '../src/versionHelpers.ts'

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

console.log('🧪 Testing autoBumpVersionBy / normalizeAutoBumpLevel...\n')

console.log('1️⃣  Patch bump (autoBumpVersion / level patch)...')
assertEqual(autoBumpVersion('1.0.0'), '1.0.1', '1.0.0 → patch')
assertEqual(autoBumpVersion('0.0.9'), '0.0.10', '0.0.9 → patch')
assertEqual(autoBumpVersion('2.3.4'), '2.3.5', '2.3.4 → patch')
assertEqual(autoBumpVersionBy('2.3.4', 'patch'), '2.3.5', 'by patch')
assertEqual(autoBumpVersionBy('1.0.0', 'major'), '2.0.0', 'by major via autoBumpVersionBy')

console.log('\n2️⃣  Minor bump (autoBumpMinorVersion / default)...')
assertEqual(autoBumpMinorVersion('1.0.0'), '1.1.0', '1.0.0 → minor')
assertEqual(autoBumpMinorVersion('0.0.9'), '0.1.0', '0.0.9 → minor')
assertEqual(autoBumpMinorVersion('2.3.4'), '2.4.0', '2.3.4 → minor')
assertEqual(autoBumpMinorVersion('1.9.0'), '1.10.0', '1.9.0 → minor')
assertEqual(autoBumpMinorVersion('0.1.0'), '0.2.0', '0.1.0 → minor')
assertEqual(autoBumpVersionBy('1.0.0', 'minor'), '1.1.0', 'by minor')
assertEqual(autoBumpVersionBy('1.0.0'), '1.1.0', 'default level = minor')

console.log('\n3️⃣  Major bump...')
assertEqual(autoBumpVersionBy('1.0.0', 'major'), '2.0.0', '1.0.0 → major')
assertEqual(autoBumpVersionBy('2.3.4', 'major'), '3.0.0', '2.3.4 → major')
assertEqual(autoBumpVersionBy('0.9.9', 'major'), '1.0.0', '0.9.9 → major')

console.log('\n4️⃣  Metadata / prerelease bump...')
assertEqual(autoBumpVersionBy('1.2.3', 'metadata'), '1.2.4-0', '1.2.3 → metadata (prepatch)')
assertEqual(autoBumpVersionBy('1.2.3-beta.0', 'metadata'), '1.2.3-beta.1', 'beta.0 → beta.1')
assertEqual(autoBumpVersionBy('1.2.3-0', 'metadata'), '1.2.3-1', '1.2.3-0 → 1.2.3-1')
assertEqual(autoBumpVersionBy('1.2.3', 'prerelease'), '1.2.4-0', 'prerelease alias')

console.log('\n5️⃣  Chained minor bumps (free-slot walk)...')
let v = '0.0.9'
v = autoBumpMinorVersion(v)
assertEqual(v, '0.1.0', 'first minor from 0.0.9')
v = autoBumpMinorVersion(v)
assertEqual(v, '0.2.0', 'second minor')
v = autoBumpMinorVersion(v)
assertEqual(v, '0.3.0', 'third minor')

console.log('\n6️⃣  Fallback for non-strict semver-like strings...')
assertEqual(autoBumpMinorVersion('3.2.1-beta'), '3.3.0', 'prerelease base → minor via @std/semver or fallback')

console.log('\n7️⃣  normalizeAutoBumpLevel / normalizeAutoBumpInput...')
assertEqual(normalizeAutoBumpLevel(true), 'minor', 'true → minor')
assertEqual(normalizeAutoBumpLevel(undefined), undefined, 'undefined → undefined')
assertEqual(normalizeAutoBumpLevel(false), undefined, 'false → undefined')
assertEqual(normalizeAutoBumpLevel('fix'), 'patch', 'fix → patch')
assertEqual(normalizeAutoBumpLevel('Fix'), 'patch', 'Fix → patch')
assertEqual(normalizeAutoBumpLevel('major'), 'major', 'major')
assertEqual(normalizeAutoBumpLevel('minor'), 'minor', 'minor')
assertEqual(normalizeAutoBumpLevel('patch'), 'patch', 'patch')
assertEqual(normalizeAutoBumpLevel('metadata'), 'metadata', 'metadata')
assertEqual(normalizeAutoBumpLevel('ai'), undefined, 'ai excluded from level normalize')
assertEqual(normalizeAutoBumpLevel('nope'), undefined, 'invalid → undefined')
assertEqual(normalizeAutoBumpInput('ai'), 'ai', 'ai input')
assertEqual(normalizeAutoBumpInput('Ai'), 'ai', 'Ai → ai')
assertEqual(normalizeAutoBumpInput('patch'), 'patch', 'input patch')
assertEqual(normalizeAutoBumpInput(true), 'minor', 'input true → minor')
assertEqual(normalizeAutoBumpInput('nope'), undefined, 'input invalid → undefined')

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log(`📊 Test Results: ${passed} passed, ${failed} failed`)
if (failed > 0)
  process.exit(1)
console.log('✅ All auto-bump version tests passed')
