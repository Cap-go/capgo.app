#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

console.log('upload HTTP path tests passed')
