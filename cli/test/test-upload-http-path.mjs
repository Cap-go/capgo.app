#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assertSecureSupabaseHost } from '../src/utils.ts'
import { sliceUploadHotPath } from './upload-hot-path-guard.mjs'

const uploadSource = readFileSync(new URL('../src/bundle/upload.ts', import.meta.url), 'utf8')
const utilsSource = readFileSync(new URL('../src/utils.ts', import.meta.url), 'utf8')
const uploadHotPath = sliceUploadHotPath(uploadSource)

assert.doesNotMatch(uploadHotPath, /supabase\.from\(/, 'upload hot path must not call supabase.from')
assert.doesNotMatch(uploadHotPath, /supabase\.rpc\(/, 'upload hot path must not call supabase.rpc')
assert.doesNotMatch(uploadHotPath, /functions\.invoke\(/, 'upload hot path must not call functions.invoke')
assert.match(uploadSource, /updateOrCreateVersion\(ctx\.apikey/, 'upload must prepare versions via Capgo HTTP')
assert.match(uploadSource, /finishTusUploadVersion\(ctx\.apikey/, 'upload must finalize TUS via Capgo HTTP')
assert.match(utilsSource, /export async function checkPlanValidUploadViaHttp/, 'plan validation HTTP helper must exist')

assert.equal(assertSecureSupabaseHost('http://localhost:54321'), 'http://localhost:54321')
assert.equal(assertSecureSupabaseHost('http://127.0.0.1:54321'), 'http://127.0.0.1:54321')
assert.equal(assertSecureSupabaseHost('http://[::1]:54321'), 'http://[::1]:54321')
assert.throws(() => assertSecureSupabaseHost('http://db.example.com'), /HTTPS/)

console.log('upload HTTP path tests passed')
