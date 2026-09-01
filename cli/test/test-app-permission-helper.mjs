#!/usr/bin/env node
import assert from 'node:assert/strict'
import { checkAppExistsAndHasPermissionOrgErr } from '../src/api/app.ts'
import { CliUserError } from '../src/shared/cli-user-error.ts'
import { shouldCapturePosthogException } from '../src/posthog.ts'

const originalFetch = globalThis.fetch
const fetchCalls = []
let permissionAllowed = true

globalThis.fetch = async (input, init) => {
  const url = String(input)
  fetchCalls.push({ url, method: init?.method ?? 'GET', body: init?.body })
  if (url.includes('/private/config')) {
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (url.includes('/private/cli/check-permission')) {
    return new Response(JSON.stringify({ allowed: permissionAllowed }), {
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
    'ck_plain_cli_key',
    'com.example.app',
    'app.read_bundles',
    { silent: true, skip2FACheck: true },
  )

  assert.ok(fetchCalls.some(call => call.url.includes('/private/cli/check-permission')), 'expected HTTP permission check')
  assert.ok(fetchCalls.some(call => /\/app\/com\.example\.app$/.test(call.url)), 'expected GET app existence check')
  const permissionCall = fetchCalls.find(call => call.url.includes('/private/cli/check-permission'))
  assert.deepEqual(JSON.parse(permissionCall.body), {
    permission_key: 'app.read_bundles',
    org_id: null,
    app_id: 'com.example.app',
    channel_id: null,
  })

  fetchCalls.length = 0

  await checkAppExistsAndHasPermissionOrgErr(
    'ck_channel_cli_key',
    'com.example.app',
    'channel.delete',
    { silent: true, skip2FACheck: true, channelId: 42 },
  )

  assert.equal(fetchCalls.filter(call => /\/app\//.test(call.url)).length, 0, 'channel-scoped checks skip app existence HTTP call')
  assert.deepEqual(JSON.parse(fetchCalls.find(call => call.url.includes('/private/cli/check-permission')).body), {
    permission_key: 'channel.delete',
    org_id: null,
    app_id: 'com.example.app',
    channel_id: 42,
  })
  fetchCalls.length = 0

  await checkAppExistsAndHasPermissionOrgErr(
    'ck_channel_update_key',
    'com.example.app',
    'channel.update_settings',
    { silent: true, skip2FACheck: true, channelId: 77 },
  )

  assert.deepEqual(JSON.parse(fetchCalls.find(call => call.url.includes('/private/cli/check-permission')).body), {
    permission_key: 'channel.update_settings',
    org_id: null,
    app_id: 'com.example.app',
    channel_id: 77,
  })

  fetchCalls.length = 0
  permissionAllowed = false

  await assert.rejects(
    () => checkAppExistsAndHasPermissionOrgErr(
      'ck_denied_key',
      'com.example.app',
      'app.upload_bundle',
      { silent: true, skip2FACheck: true },
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

  assert.ok(fetchCalls.some(call => call.url.includes('/private/cli/check-permission')), 'denied path still uses HTTP permission check')

  console.log('app permission helper tests passed')
}
finally {
  globalThis.fetch = originalFetch
}
