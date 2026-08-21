#!/usr/bin/env node
import assert from 'node:assert/strict'
import { checkAppExistsAndHasPermissionOrgErr } from '../src/api/app.ts'
import { CliUserError } from '../src/shared/cli-user-error.ts'
import { shouldCapturePosthogException } from '../src/posthog.ts'

const calls = []
const supabase = {
  from() {
    return {}
  },
  rpc(name, args) {
    calls.push({ name, args })
    if (name === 'cli_check_permission') {
      return Promise.resolve({ data: true, error: null })
    }
    throw new Error(`Unexpected RPC call: ${name}`)
  },
}

const originalFetch = globalThis.fetch
const fetchCalls = []

globalThis.fetch = async (input, init) => {
  const url = String(input)
  fetchCalls.push({ url, method: init?.method ?? 'GET' })
  if (url.includes('/private/config')) {
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (url.includes('/app/com.example.app')) {
    return new Response(JSON.stringify({
      app_id: 'com.example.app',
      owner_org: 'org_123',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  })
}

try {
  await checkAppExistsAndHasPermissionOrgErr(
    supabase,
    'ck_plain_cli_key',
    'com.example.app',
    'app.read_bundles',
    true,
    true,
  )

  assert.deepEqual(calls.map(call => call.name), ['cli_check_permission'])
  assert.ok(fetchCalls.some(call => /\/app\/com\.example\.app$/.test(call.url)), 'expected GET app existence check')
  assert.deepEqual(calls[0].args, {
    apikey: 'ck_plain_cli_key',
    permission_key: 'app.read_bundles',
    org_id: null,
    app_id: 'com.example.app',
    channel_id: null,
  })

  calls.length = 0
  fetchCalls.length = 0

  await checkAppExistsAndHasPermissionOrgErr(
    supabase,
    'ck_channel_cli_key',
    'com.example.app',
    'channel.delete',
    true,
    true,
    42,
  )

  assert.deepEqual(calls.map(call => call.name), ['cli_check_permission'])
  assert.equal(fetchCalls.filter(call => /\/app\//.test(call.url)).length, 0, 'channel-scoped checks skip app existence HTTP call')
  assert.deepEqual(calls[0].args, {
    apikey: 'ck_channel_cli_key',
    permission_key: 'channel.delete',
    org_id: null,
    app_id: 'com.example.app',
    channel_id: 42,
  })
  calls.length = 0
  fetchCalls.length = 0

  await checkAppExistsAndHasPermissionOrgErr(
    supabase,
    'ck_channel_update_key',
    'com.example.app',
    'channel.update_settings',
    true,
    true,
    77,
  )

  assert.deepEqual(calls.map(call => call.name), ['cli_check_permission'])
  assert.deepEqual(calls[0].args, {
    apikey: 'ck_channel_update_key',
    permission_key: 'channel.update_settings',
    org_id: null,
    app_id: 'com.example.app',
    channel_id: 77,
  })

  calls.length = 0
  fetchCalls.length = 0

  const deniedSupabase = {
    rpc(name, args) {
      calls.push({ name, args })
      if (name === 'cli_check_permission') {
        return Promise.resolve({ data: false, error: null })
      }
      throw new Error(`Unexpected RPC call: ${name}`)
    },
  }

  await assert.rejects(
    () => checkAppExistsAndHasPermissionOrgErr(
      deniedSupabase,
      'ck_denied_key',
      'com.example.app',
      'app.upload_bundle',
      true,
      true,
    ),
    (error) => {
      assert.equal(error instanceof CliUserError, true)
      assert.equal(
        error.message,
        'Insufficient permissions for app. Required RBAC permission for this action: app.upload_bundle.',
      )
      assert.deepEqual(error.context, {
        appId: 'com.example.app',
        requiredPermissionKey: 'app.upload_bundle',
      })
      assert.equal(shouldCapturePosthogException(error), false)
      return true
    },
  )

  assert.deepEqual(calls.map(call => call.name), ['cli_check_permission'])

  console.log('app permission helper tests passed')
}
finally {
  globalThis.fetch = originalFetch
}
