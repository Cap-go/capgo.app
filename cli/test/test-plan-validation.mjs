#!/usr/bin/env node
process.env.CAPGO_DISABLE_POSTHOG = '1'

import { readFileSync } from 'node:fs'
import process from 'node:process'
import * as utils from '../src/utils.ts'

console.log('🧪 Testing app-aware plan validation...\n')

const utilsSource = readFileSync(new URL('../src/utils.ts', import.meta.url), 'utf8')
const channelSetSource = readFileSync(new URL('../src/channel/set.ts', import.meta.url), 'utf8')

const httpOptions = {
  supaHost: 'http://localhost:54321',
  supaAnon: 'test-anon-key',
}

function makeSupabase() {
  return {
    supabaseUrl: httpOptions.supaHost,
    supabaseKey: httpOptions.supaAnon,
    rest: {
      headers: {
        get(name) {
          return name.toLowerCase() === 'capgkey' ? 'test-plan-key' : null
        },
      },
    },
  }
}

const originalFetch = globalThis.fetch
const httpCalls = []
let fetchHandler = () => new Response(JSON.stringify({ allowed: true }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
})

globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (!url.includes('/private/cli/billing/'))
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

  fetchHandler = () => new Response(JSON.stringify({ allowed: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

  const allowed = await utils.isAllowedPlanActions(
    makeSupabase(),
    'org-id',
    ['mau', 'storage', 'bandwidth', 'build_time'],
    'com.example.app',
    httpOptions,
  )

  assertEquals(allowed, true)
  assertEquals(httpCalls.length, 1)
  assert(httpCalls[0].url.includes('/private/cli/billing/allowed-actions'))
  assertEquals(httpCalls[0].method, 'POST')
  assertEquals(httpCalls[0].body, {
    org_id: 'org-id',
    actions: ['mau', 'storage', 'bandwidth', 'build_time'],
    app_id: 'com.example.app',
  })
})

await test('surfaces plan RPC errors instead of reporting an invalid plan', async () => {
  assert(typeof utils.isAllowedPlanActions === 'function', 'Expected isAllowedPlanActions to be exported')

  fetchHandler = () => new Response(JSON.stringify({ error: 'permission lookup failed' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  })

  let thrown
  try {
    await utils.isAllowedPlanActions(makeSupabase(), 'org-id', ['storage'], 'com.example.app', httpOptions)
  }
  catch (error) {
    thrown = error
  }

  assert(thrown instanceof Error, 'Expected the RPC error to be thrown')
  assert(thrown.message.includes('Cannot validate plan'), `Unexpected error: ${thrown.message}`)
})

await test('falls back to organization validation when the app-aware RPC is unavailable', async () => {
  fetchHandler = (url) => {
    if (url.includes('/private/cli/billing/allowed-actions')) {
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ allowed: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const allowed = await utils.isAllowedPlanActions(
    makeSupabase(),
    'org-id',
    ['storage'],
    'com.example.app',
    httpOptions,
  )

  assertEquals(allowed, true)
  assertEquals(httpCalls.length, 2)
  assert(httpCalls[0].url.includes('/private/cli/billing/allowed-actions'))
  assertEquals(httpCalls[0].body, {
    org_id: 'org-id',
    actions: ['storage'],
    app_id: 'com.example.app',
  })
  assert(httpCalls[1].url.includes('/private/cli/billing/allowed?org_id=org-id'))
})

await test('surfaces organization plan RPC errors instead of reporting an invalid plan', async () => {
  fetchHandler = () => new Response(JSON.stringify({ error: 'organization lookup failed' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  })

  let thrown
  try {
    await utils.isAllowedActionOrg(makeSupabase(), 'org-id', httpOptions)
  }
  catch (error) {
    thrown = error
  }

  assert(thrown instanceof Error, 'Expected the organization RPC error to be thrown')
  assert(thrown.message.includes('Cannot validate plan'), `Unexpected error: ${thrown.message}`)
})

await test('treats app-scoped RBAC denial as permission_denied when org plan is allowed', async () => {
  fetchHandler = (_url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined
    const allowed = body?.app_id ? false : true
    return new Response(JSON.stringify({ allowed }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const result = await utils.resolveMeteredPlanAllowed(
    makeSupabase(),
    'org-id',
    ['mau', 'storage', 'bandwidth', 'build_time'],
    'com.example.app',
    httpOptions,
  )

  assertEquals(result, 'permission_denied')
})

await test('checkPlanValid reports permission denial instead of billing upgrade copy', async () => {
  fetchHandler = (_url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined
    const allowed = body?.app_id ? false : true
    return new Response(JSON.stringify({ allowed }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let thrown
  try {
    await utils.checkPlanValid(makeSupabase(), 'org-id', 'com.example.app', false, httpOptions)
  }
  catch (error) {
    thrown = error
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

globalThis.fetch = originalFetch

console.log(`\n📊 Results: ${testsPassed} passed, ${testsFailed} failed`)
if (testsFailed > 0)
  process.exit(1)
