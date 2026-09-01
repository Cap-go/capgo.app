#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import process from 'node:process'
import * as utils from '../src/utils.ts'

console.log('🧪 Testing app-aware plan validation...\n')

const utilsSource = readFileSync(new URL('../src/utils.ts', import.meta.url), 'utf8')
const channelSetSource = readFileSync(new URL('../src/channel/set.ts', import.meta.url), 'utf8')

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

const HOST = { supaHost: 'https://fake.supabase.co', supaAnon: 'fake-anon' }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

await test('checks an app-scoped key through Capgo HTTP plan API', async () => {
  assert(typeof utils.checkPlanValid === 'function', 'Expected checkPlanValid to be exported')

  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, method: init?.method, body: init?.body })
    if (url.includes('/private/config'))
      return json({ hostWeb: 'https://console.capgo.app' })
    if (url.includes('/private/cli/check-plan'))
      return json({ result: 'allowed', valid: true, trial_days: 0, is_paying: true, has_credits: false })
    throw new Error(`Unexpected fetch: ${url}`)
  }

  try {
    await utils.checkPlanValid('ck_key', 'org-id', 'com.example.app', false, HOST)
    const planCall = calls.find(call => String(call.url).includes('/private/cli/check-plan'))
    assert(planCall, 'Expected HTTP plan check')
    assertEquals(JSON.parse(planCall.body), {
      org_id: 'org-id',
      app_id: 'com.example.app',
      actions: ['mau', 'storage', 'bandwidth', 'build_time'],
    })
  }
  finally {
    globalThis.fetch = originalFetch
  }
})

await test('surfaces plan HTTP errors instead of reporting an invalid plan', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes('/private/config'))
      return json({ hostWeb: 'https://console.capgo.app' })
    if (url.includes('/private/cli/check-plan'))
      return json({ error: 'permission lookup failed' }, 500)
    throw new Error(`Unexpected fetch: ${url}`)
  }

  let thrown
  try {
    await utils.checkPlanValid('ck_key', 'org-id', 'com.example.app', false, HOST)
  }
  catch (error) {
    thrown = error
  }
  finally {
    globalThis.fetch = originalFetch
  }

  assert(thrown instanceof Error, 'Expected the HTTP error to be thrown')
  assert(thrown.message.includes('Cannot validate plan'), `Unexpected error: ${thrown.message}`)
})

await test('checkPlanValid reports permission denial instead of billing upgrade copy', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes('/private/config'))
      return json({ hostWeb: 'https://console.capgo.app' })
    if (url.includes('/private/cli/check-plan'))
      return json({ result: 'permission_denied', valid: false, trial_days: 0, is_paying: true, has_credits: false })
    throw new Error(`Unexpected fetch: ${url}`)
  }

  let thrown
  try {
    await utils.checkPlanValid('ck_key', 'org-id', 'com.example.app', false, HOST)
  }
  catch (error) {
    thrown = error
  }
  finally {
    globalThis.fetch = originalFetch
  }

  assert(thrown instanceof Error, 'Expected plan validation to throw')
  assert(thrown.message.includes('Plan validation permission denied'), `Unexpected error: ${thrown.message}`)
  assert(!thrown.message.includes('Plan upgrade required'), 'Must not report a billing upgrade for RBAC denial')
})

await test('canOpenExternalUrl is disabled in CI-like environments', () => {
  assert(typeof utils.canOpenExternalUrl === 'function', 'Expected canOpenExternalUrl to be exported')
  assertEquals(utils.canOpenExternalUrl({
    ci: true,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    display: ':0',
    platform: 'linux',
  }), false)
  assertEquals(utils.canOpenExternalUrl({
    ci: false,
    stdinIsTTY: false,
    stdoutIsTTY: true,
    display: ':0',
    platform: 'linux',
  }), false)
  assertEquals(utils.canOpenExternalUrl({
    ci: false,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    display: undefined,
    platform: 'linux',
  }), false)
  assertEquals(utils.canOpenExternalUrl({
    ci: false,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    display: ':0',
    platform: 'darwin',
  }), true)
})

await test('plan upgrade helpers use guarded openExternalUrl instead of raw import("open")', () => {
  assert(utilsSource.includes('await openExternalUrl(plansUrl)'), 'Expected guarded browser open helper')
  assert(!utilsSource.includes('import(\'open\')\n      .then'), 'Raw fire-and-forget open() must be removed from plan checks')
  assert(utilsSource.includes('if (code === \'ENOENT\')'), 'Expected ENOENT to be swallowed in openExternalUrl')
})

await test('channel set does not run kitchen-sink plan validation', () => {
  assert(!channelSetSource.includes('checkPlanValid'), 'channel set must not call checkPlanValid')
})

console.log(`\n📊 Results: ${testsPassed} passed, ${testsFailed} failed`)
if (testsFailed > 0)
  process.exit(1)
