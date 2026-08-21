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

await test('falls back to organization validation when the app-aware RPC is unavailable', async () => {
  const calls = []
  const supabase = {
    rpc: (name, args) => {
      calls.push({ name, args })
      if (name === 'is_allowed_action_org_action') {
        return Promise.resolve({
          data: null,
          error: {
            code: 'PGRST202',
            message: 'Could not find the function in the schema cache',
          },
        })
      }
      return {
        single: async () => ({ data: true, error: null }),
      }
    },
  }

  const allowed = await utils.isAllowedPlanActions(
    supabase,
    'org-id',
    ['storage'],
    'com.example.app',
  )

  assertEquals(allowed, true)
  assertEquals(calls, [
    {
      name: 'is_allowed_action_org_action',
      args: {
        orgid: 'org-id',
        actions: ['storage'],
        appid: 'com.example.app',
      },
    },
    {
      name: 'is_allowed_action_org',
      args: { orgid: 'org-id' },
    },
  ])
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

await test('treats app-scoped RBAC denial as permission_denied when org plan is allowed', async () => {
  const supabase = {
    rpc: async (name, args) => {
      if (name === 'is_allowed_action_org_action' && args.appid)
        return { data: false, error: null }
      if (name === 'is_allowed_action_org_action')
        return { data: true, error: null }
      throw new Error(`Unexpected RPC ${name}`)
    },
  }

  const result = await utils.resolveMeteredPlanAllowed(
    supabase,
    'org-id',
    ['mau', 'storage', 'bandwidth', 'build_time'],
    'com.example.app',
  )

  assertEquals(result, 'permission_denied')
})

await test('checkPlanValid reports permission denial instead of billing upgrade copy', async () => {
  const supabase = {
    rpc: async (name, args) => {
      if (name === 'is_allowed_action_org_action' && args.appid)
        return { data: false, error: null }
      if (name === 'is_allowed_action_org_action')
        return { data: true, error: null }
      throw new Error(`Unexpected RPC ${name}`)
    },
  }

  let thrown
  try {
    await utils.checkPlanValid(supabase, 'org-id', 'com.example.app', false)
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

console.log(`\n📊 Results: ${testsPassed} passed, ${testsFailed} failed`)
if (testsFailed > 0)
  process.exit(1)
