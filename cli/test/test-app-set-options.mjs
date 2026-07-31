#!/usr/bin/env node

import assert from 'node:assert/strict'
import { resolveAppSetIconPath } from '../src/api/app.ts'
import { normalizeStoreUrl } from '../src/app/store-url.ts'

let failures = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  }
  catch (error) {
    failures += 1
    console.error(`❌ ${name}`)
    console.error(error)
  }
}

await test('normalizes ios store urls', () => {
  assert.equal(
    normalizeStoreUrl('https://apps.apple.com/app/id123', 'apps.apple.com'),
    'https://apps.apple.com/app/id123',
  )
})

await test('normalizes android store urls', () => {
  assert.equal(
    normalizeStoreUrl('https://play.google.com/store/apps/details?id=com.demo', 'play.google.com'),
    'https://play.google.com/store/apps/details?id=com.demo',
  )
})

await test('rejects prefixed subdomains', () => {
  assert.throws(
    () => normalizeStoreUrl('https://evilapps.apple.com/app', 'apps.apple.com'),
    /apps\.apple\.com/,
  )
})

await test('rejects invalid store hosts', () => {
  assert.throws(
    () => normalizeStoreUrl('https://example.com/app', 'apps.apple.com'),
    /apps\.apple\.com/,
  )
})

await test('does not resolve app set icon without --icon', () => {
  assert.equal(resolveAppSetIconPath(undefined), undefined)
})

await test('resolves app set icon only when --icon is passed', () => {
  assert.equal(resolveAppSetIconPath('./assets/capgo-icon.png'), './assets/capgo-icon.png')
})

if (failures > 0) {
  console.error(`\n❌ ${failures} app set option test(s) failed`)
  process.exit(1)
}

console.log('\n✅ App set option checks work')
