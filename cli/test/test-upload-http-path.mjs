#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assertSecureSupabaseHost } from '../src/utils.ts'
import {
  FUNCTIONS_INVOKE_PATTERN,
  sliceUploadHotPath,
  SUPABASE_FROM_PATTERN,
  SUPABASE_RPC_PATTERN,
} from './upload-hot-path-guard.mjs'

const uploadSource = readFileSync(new URL('../src/bundle/upload.ts', import.meta.url), 'utf8')
const utilsSource = readFileSync(new URL('../src/utils.ts', import.meta.url), 'utf8')
const uploadHotPath = sliceUploadHotPath(uploadSource)

assert.doesNotMatch(uploadHotPath, SUPABASE_FROM_PATTERN, 'upload hot path must not call supabase.from')
assert.doesNotMatch(uploadHotPath, SUPABASE_RPC_PATTERN, 'upload hot path must not call supabase.rpc')
assert.doesNotMatch(uploadHotPath, FUNCTIONS_INVOKE_PATTERN, 'upload hot path must not call functions.invoke')
assert.match(uploadSource, /updateOrCreateVersion\(ctx\.apikey/, 'upload must prepare versions via Capgo HTTP')
assert.match(uploadSource, /finishTusUploadVersion\(ctx\.apikey/, 'upload must finalize TUS via Capgo HTTP')
assert.match(utilsSource, /export async function checkPlanValidUploadViaHttp/, 'plan validation HTTP helper must exist')

assert.equal(assertSecureSupabaseHost('http://localhost:54321'), 'http://localhost:54321')
assert.equal(assertSecureSupabaseHost('http://127.0.0.1:54321'), 'http://127.0.0.1:54321')
assert.equal(assertSecureSupabaseHost('http://[::1]:54321'), 'http://[::1]:54321')
assert.throws(() => assertSecureSupabaseHost('http://db.example.com'), /HTTPS/)

const { invokeCapgoCliApi } = await import('../src/utils.ts')
const insecureHostResult = await invokeCapgoCliApi('private/cli/check-permission', {
  apikey: 'ck_key',
  method: 'POST',
  body: { permission_key: 'app.read', org_id: null, app_id: 'com.example.app', channel_id: null },
  supaHost: 'http://db.example.com',
  supaAnon: 'anon-key',
})
assert.equal(insecureHostResult.data, null)
assert.match(insecureHostResult.error?.message ?? '', /HTTPS/)

console.log('upload HTTP path tests passed')
