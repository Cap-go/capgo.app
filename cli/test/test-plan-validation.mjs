#!/usr/bin/env node
process.env.CAPGO_DISABLE_POSTHOG = '1'

import { readFileSync } from 'node:fs'
import process from 'node:process'
import { checkPlanValid, checkPlanValidUpload } from '../src/api/preflight.ts'
import * as utils from '../src/utils.ts'

console.log('🧪 Testing plan validation through the backend preflight...\n')

const utilsSource = readFileSync(new URL('../src/utils.ts', import.meta.url), 'utf8')
const preflightSource = readFileSync(new URL('../src/api/preflight.ts', import.meta.url), 'utf8')
const channelSetSource = readFileSync(new URL('../src/channel/set.ts', import.meta.url), 'utf8')

const apiHost = 'http://localhost:54321/functions/v1'

function makeClient() {
  return { apikey: 'test-plan-key', apiHost, filesHost: apiHost }
}

const originalFetch = globalThis.fetch
const httpCalls = []
const okBody = { user_id: 'u1', org_id: 'org-id', app_id: 'com.example.app', trial_days_left: null, warnings: [] }
let fetchHandler = () => Response.json(okBody)

globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (!url.includes('/private/cli/preflight'))
    return originalFetch(input)
  httpCalls.push({
    url,
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(init.body) : undefined,
  })
  return fetchHandler(url, init)
}

let testsPassed = 0
let testsFailed = 0

async function test(name, fn) {
  try {
    console.log(`\n🔍 ${name}`)
    httpCalls.length = 0
    fetchHandler = () => Response.json(okBody)
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

async function rejection(fn) {
  try {
    await fn()
  }
  catch (error) {
    return error
  }
  throw new Error('Expected a rejection')
}

await test('checkPlanValid asks the backend for the full metered plan in one call', async () => {
  await checkPlanValid(makeClient(), 'org-id', 'com.example.app', false)
  assertEquals(httpCalls.length, 1)
  assertEquals(httpCalls[0].url, `${apiHost}/private/cli/preflight`)
  assertEquals(httpCalls[0].body, { app_id: 'com.example.app', org_id: 'org-id', check_2fa: false, plan: 'all' })
})

await test('checkPlanValidUpload only gates storage', async () => {
  await checkPlanValidUpload(makeClient(), 'org-id', 'com.example.app', false)
  assertEquals(httpCalls[0].body, { app_id: 'com.example.app', org_id: 'org-id', check_2fa: false, plan: 'upload' })
})

await test('billing limit maps to plan upgrade copy', async () => {
  fetchHandler = () => Response.json({ error: 'plan_upgrade_required', message: 'Plan upgrade required' }, { status: 402 })
  const error = await rejection(() => checkPlanValidUpload(makeClient(), 'org-id', 'com.example.app', false))
  assertEquals(error.message, 'Plan upgrade required for upload')
})

await test('checkPlanValid reports permission denial instead of billing upgrade copy', async () => {
  fetchHandler = () => Response.json({ error: 'plan_permission_denied', message: 'denied' }, { status: 403 })
  const error = await rejection(() => checkPlanValid(makeClient(), 'org-id', 'com.example.app', false))
  assert(error.message.includes('Plan validation permission denied'), `Unexpected error: ${error.message}`)
  assert(!error.message.includes('Plan upgrade required'), 'Must not report a billing upgrade for RBAC denial')
})

await test('surfaces backend errors instead of reporting an invalid plan', async () => {
  fetchHandler = () => Response.json({ error: 'cannot_check_billing', message: 'Cannot check org plan actions' }, { status: 400 })
  const error = await rejection(() => checkPlanValid(makeClient(), 'org-id', 'com.example.app', false))
  assert(error.message.includes('Cannot check org plan actions'), `Unexpected error: ${error.message}`)
  assert(!error.message.includes('Plan upgrade required'), 'Backend failure must not look like an invalid plan')
})

await test('no CLI-side plan RPC helpers remain', () => {
  for (const name of ['isAllowedPlanActions', 'resolveMeteredPlanAllowed', 'isAllowedActionOrg', 'isPayingOrg', 'isTrialOrg'])
    assert(!(name in utils), `${name} must live in the backend`)
  assert(!utilsSource.includes('private/cli/billing'), 'billing routes are replaced by the preflight')
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
  assert(preflightSource.includes('await openExternalUrl(url)'), 'Expected guarded browser open helper')
  assert(!preflightSource.includes('import(\'open\')'), 'Raw open() must not be used by plan checks')
  assert(utilsSource.includes('if (code === \'ENOENT\')'), 'Expected ENOENT to be swallowed in openExternalUrl')
})

await test('channel set does not run kitchen-sink plan validation', () => {
  assert(!channelSetSource.includes('checkPlanValid'), 'channel set must not call checkPlanValid')
})

globalThis.fetch = originalFetch

console.log(`\n📊 Results: ${testsPassed} passed, ${testsFailed} failed`)
if (testsFailed > 0)
  process.exit(1)
