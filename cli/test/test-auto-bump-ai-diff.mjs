#!/usr/bin/env node
/**
 * Unit tests for diffManifests (AI auto-bump)
 */

import { diffManifests } from '../src/bundle/auto-bump-ai.ts'

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

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`   ✓ ${label}`)
    passed++
  }
  else {
    console.error(`   ❌ ${label}: expected ${e}, got ${a}`)
    failed++
  }
}

console.log('🧪 Testing diffManifests...\n')

console.log('1️⃣  Added / removed / changed...')
const diff = diffManifests(
  [
    { file: 'index.js', hash: 'aaa' },
    { file: 'new.js', hash: 'nnn' },
    { file: 'same.js', hash: 'sss' },
  ],
  [
    { file: 'index.js', hash: 'bbb' },
    { file: 'old.js', hash: 'ooo' },
    { file: 'same.js', hash: 'sss' },
  ],
)
assertDeepEqual(diff.added.sort(), ['new.js'], 'added')
assertDeepEqual(diff.removed.sort(), ['old.js'], 'removed')
assertDeepEqual(diff.changed.sort(), ['index.js'], 'changed')
assertEqual(diff.counts.added, 1, 'counts.added')
assertEqual(diff.counts.removed, 1, 'counts.removed')
assertEqual(diff.counts.changed, 1, 'counts.changed')

console.log('\n2️⃣  Identical manifests...')
const same = diffManifests(
  [{ file: 'a.js', hash: '1' }],
  [{ file: 'a.js', hash: '1' }],
)
assertEqual(same.counts.added, 0, 'identical added')
assertEqual(same.counts.removed, 0, 'identical removed')
assertEqual(same.counts.changed, 0, 'identical changed')

console.log('\n3️⃣  Empty remote (all added)...')
const allAdded = diffManifests(
  [{ file: 'a.js', hash: '1' }, { file: 'b.js', hash: '2' }],
  [],
)
assertEqual(allAdded.counts.added, 2, 'all added')
assertEqual(allAdded.counts.removed, 0, 'none removed')

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log(`📊 Test Results: ${passed} passed, ${failed} failed`)
if (failed > 0)
  process.exit(1)
console.log('✅ All auto-bump AI diff tests passed')
