#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  resolveChannelAddDuplicateOutcome,
} from '../src/channel/add.ts'
import { isChannelAlreadyExistsError } from '../src/init/channel-conflict.ts'
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

console.log('✅ channel add duplicate handling tests passed')
