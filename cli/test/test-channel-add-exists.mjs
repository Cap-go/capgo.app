#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  addChannelInternal,
  resolveChannelAddDuplicateOutcome,
} from '../src/channel/add.ts'
import { isChannelAlreadyExistsError } from '../src/init/channel-conflict.ts'
import { shouldCapturePosthogException } from '../src/posthog.ts'
import { formatCapgoCliInvokeError } from '../src/utils.ts'

console.log('🧪 Testing channel add duplicate handling...\n')

const duplicateError = new Error('Cannot create channel: duplicate key value violates unique constraint "unique_name_app_id" | Code: 23505')
const supabase = {}

const functionsHttpError = new Error('Edge Function returned a non-2xx status code')
functionsHttpError.context = new Response(JSON.stringify({
  message: 'duplicate key value violates unique constraint "unique_name_app_id"',
  code: '23505',
}), { status: 409 })
const formattedFunctionsHttpError = await formatCapgoCliInvokeError(functionsHttpError)
assert.equal(isChannelAlreadyExistsError(formattedFunctionsHttpError), true)
assert.equal(isChannelAlreadyExistsError(functionsHttpError), false)

const readableOutcome = await resolveChannelAddDuplicateOutcome(
  {
    createError: duplicateError,
    supabase,
    appId: 'com.example.app',
    channelName: 'production',
  },
  {
    isChannelReadableByCaller: async () => true,
  },
)
assert.equal(readableOutcome, 'duplicate_readable')

const inaccessibleOutcome = await resolveChannelAddDuplicateOutcome(
  {
    createError: duplicateError,
    supabase,
    appId: 'com.example.app',
    channelName: 'production',
  },
  {
    isChannelReadableByCaller: async () => false,
  },
)
assert.equal(inaccessibleOutcome, 'duplicate_inaccessible')

const otherErrorOutcome = await resolveChannelAddDuplicateOutcome(
  {
    createError: new Error('Cannot create channel | insufficient_permissions | HTTP 403'),
    supabase,
    appId: 'com.example.app',
    channelName: 'production',
  },
  {
    isChannelReadableByCaller: async () => {
      throw new Error('isChannelReadableByCaller should not run for non-duplicate errors')
    },
  },
)
assert.equal(otherErrorOutcome, 'not_duplicate')

await assert.rejects(
  () => resolveChannelAddDuplicateOutcome(
    {
      createError: duplicateError,
      supabase,
      appId: 'com.example.app',
      channelName: 'production',
    },
    {
      isChannelReadableByCaller: async () => null,
    },
  ),
  /Grant app.read_channels or channel.read/,
)

const originalFetch = globalThis.fetch
const originalTelemetryDisabled = process.env.CAPGO_DISABLE_TELEMETRY
process.env.CAPGO_DISABLE_TELEMETRY = 'true'
const channelOptions = {
  apikey: 'ck_channel_add_duplicate_test',
  supaHost: 'https://local.test',
  supaAnon: 'anon-key',
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function runAddChannelInternalDuplicateTest(readable) {
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'

    if (url.includes('/private/config')) {
      return jsonResponse({
        supaHost: channelOptions.supaHost,
        supaKey: channelOptions.supaAnon,
        hostApi: 'https://api.capgo.app',
      })
    }
    if (url.includes('/rpc/reject_access_due_to_2fa_for_app')) {
      return jsonResponse(false)
    }
    if (url.includes('/rpc/request_actor_user_id')) {
      return jsonResponse('user-123')
    }
    if (url.includes('/rpc/cli_check_permission')) {
      return jsonResponse(true)
    }
    if (method === 'POST' && url.includes('/functions/v1/channel')) {
      return jsonResponse({
        message: 'duplicate key value violates unique constraint "unique_name_app_id"',
        code: '23505',
      }, 409)
    }
    if (method === 'GET' && url.includes('/functions/v1/app/com.example.app')) {
      return jsonResponse({ app_id: 'com.example.app', owner_org: 'org_123' })
    }
    if (url.includes('/rest/v1/channels')) {
      if (readable) {
        return jsonResponse({ name: 'production', app_id: 'com.example.app' })
      }
      return jsonResponse({
        code: 'PGRST116',
        details: 'Results contain 0 rows',
        hint: null,
        message: 'JSON object requested, multiple (or no) rows returned',
      }, 406)
    }
    if (method === 'POST' && url.includes('/private/events')) {
      return jsonResponse({ status: 'ok' })
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`)
  }

  try {
    return await addChannelInternal('production', 'com.example.app', channelOptions, true)
  }
  finally {
    globalThis.fetch = originalFetch
  }
}

const readableResult = await runAddChannelInternalDuplicateTest(true)
assert.deepEqual(readableResult, { name: 'production' })

let inaccessibleThrown
try {
  await runAddChannelInternalDuplicateTest(false)
}
catch (error) {
  inaccessibleThrown = error
}
assert.ok(inaccessibleThrown instanceof Error)
assert.match(
  inaccessibleThrown.message,
  /Cannot create channel: Channel production already exists but is not accessible with this API key/,
)
assert.equal(shouldCapturePosthogException(inaccessibleThrown), true)

if (originalTelemetryDisabled === undefined)
  delete process.env.CAPGO_DISABLE_TELEMETRY
else
  process.env.CAPGO_DISABLE_TELEMETRY = originalTelemetryDisabled

console.log('✅ channel add duplicate handling tests passed')
