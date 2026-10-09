#!/usr/bin/env node
import assert from 'node:assert/strict'
import { checkAppExistsAndHasPermissionOrgErr } from '../src/api/app.ts'
import { CliUserError } from '../src/shared/cli-user-error.ts'
import { shouldCapturePosthogException } from '../src/posthog.ts'

const apiHost = 'https://api.example.test'
const client = key => ({ apikey: key, apiHost, filesHost: apiHost })

const originalFetch = globalThis.fetch
const preflightCalls = []
let preflightResponse = () => new Response(JSON.stringify({ user_id: 'u1', org_id: 'org_123', app_id: 'com.example.app', trial_days_left: null, warnings: [] }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
})

globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url.includes('/private/config')) {
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (url === `${apiHost}/private/cli/preflight`) {
    preflightCalls.push({ body: JSON.parse(String(init?.body ?? '{}')), headers: init?.headers })
    return preflightResponse()
  }
  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  })
}

try {
  await checkAppExistsAndHasPermissionOrgErr(client('ck_plain_cli_key'), 'ck_plain_cli_key', 'com.example.app', 'app.read_bundles', true, true)

  assert.equal(preflightCalls.length, 1, 'one backend call per check')
  assert.deepEqual(preflightCalls[0].body, {
    app_id: 'com.example.app',
    permission: 'app.read_bundles',
    check_2fa: false,
  })
  assert.equal(preflightCalls[0].headers.capgkey, 'ck_plain_cli_key')
  assert.equal(preflightCalls[0].headers.capgo_api, '2025-10-01', 'CLI pins the capgo_api version')

  preflightCalls.length = 0
  await checkAppExistsAndHasPermissionOrgErr(client('ck_channel_cli_key'), 'ck_channel_cli_key', 'com.example.app', 'channel.delete', true, false, 42)
  assert.deepEqual(preflightCalls[0].body, {
    app_id: 'com.example.app',
    channel_id: 42,
    permission: 'channel.delete',
    check_2fa: true,
  })

  preflightCalls.length = 0
  preflightResponse = () => new Response(JSON.stringify({ error: 'permission_denied', message: 'Missing permission app.upload_bundle' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  })

  await assert.rejects(
    () => checkAppExistsAndHasPermissionOrgErr(client('ck_denied_key'), 'ck_denied_key', 'com.example.app', 'app.upload_bundle', true, true),
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
  assert.equal(preflightCalls.length, 1)

  preflightResponse = () => new Response(JSON.stringify({ error: 'app_not_found', message: 'App not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  })
  await assert.rejects(
    () => checkAppExistsAndHasPermissionOrgErr(client('ck_missing_app'), 'ck_missing_app', 'com.example.app', 'app.read', true, true),
    /cli app add com\.example\.app/,
  )

  console.log('app permission helper tests passed')
}
finally {
  globalThis.fetch = originalFetch
}
