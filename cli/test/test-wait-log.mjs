#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

console.log('🧪 Testing onboarding waitLog query + skip...\n')

const {
  WAIT_LOG_LOOKBACK_MS,
  buildWaitLogQuery,
  isWaitLogContinueKey,
} = await import('../src/app/wait-log-query.ts')

let failures = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`✅ ${name}`)
  }
  catch (error) {
    failures += 1
    console.error(`❌ ${name}`)
    console.error(error)
  }
}

await test('does not filter stats by device id unless one was provided', () => {
  const query = buildWaitLogQuery('com.dogg.foodd.app', undefined, new Date('2026-08-13T12:00:00.000Z'))
  assert.equal(query.appId, 'com.dogg.foodd.app')
  assert.equal(query.devicesId, undefined)
  assert.equal(query.rangeStart, '2026-08-13T11:55:00.000Z')
  assert.equal(WAIT_LOG_LOOKBACK_MS, 5 * 60 * 1000)
})

await test('only uses a real device id when filtering stats', () => {
  const query = buildWaitLogQuery('com.dogg.foodd.app', 'device-123', new Date('2026-08-13T12:00:00.000Z'))
  assert.deepEqual(query.devicesId, ['device-123'])
})

await test('C continues and Ctrl+C is not treated as the continue key', () => {
  assert.equal(isWaitLogContinueKey('c'), true)
  assert.equal(isWaitLogContinueKey('C'), true)
  assert.equal(isWaitLogContinueKey('c\n'), true)
  assert.equal(isWaitLogContinueKey('c', true), false)
  assert.equal(isWaitLogContinueKey('\u0003'), false)
  assert.equal(isWaitLogContinueKey('x'), false)
})

await test('onboarding waitLog call passes orgId, not the API key, as orgId', () => {
  const commandSrc = readFileSync(new URL('../src/init/command.ts', import.meta.url), 'utf8')
  assert.match(commandSrc, /waitLog\(\s*'onboarding-v2',\s*apikey,\s*appId,\s*orgId/)
  assert.doesNotMatch(commandSrc, /waitLog\(\s*'onboarding-v2',\s*apikey,\s*appId,\s*apikey/)
})

if (failures > 0) {
  console.error(`\n❌ ${failures} waitLog test(s) failed`)
  process.exit(1)
}

console.log('\n✅ waitLog watches app logs and can be skipped with C')
console.log(`tested from ${fileURLToPath(import.meta.url)}`)
