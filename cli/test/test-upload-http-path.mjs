#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const uploadSource = readFileSync(new URL('../src/bundle/upload.ts', import.meta.url), 'utf8')
const utilsSource = readFileSync(new URL('../src/utils.ts', import.meta.url), 'utf8')

assert.doesNotMatch(uploadSource, /supabase\.from\(/, 'upload.ts must not call supabase.from')
assert.doesNotMatch(uploadSource, /supabase\.rpc\(/, 'upload.ts must not call supabase.rpc')
assert.doesNotMatch(uploadSource, /functions\.invoke\(/, 'upload.ts must not call functions.invoke')
assert.match(uploadSource, /updateOrCreateVersion\(ctx\.apikey/, 'upload must prepare versions via Capgo HTTP')
assert.match(uploadSource, /finishTusUploadVersion\(ctx\.apikey/, 'upload must finalize TUS via Capgo HTTP')
assert.match(utilsSource, /export async function checkPlanValidUploadViaHttp/, 'plan validation HTTP helper must exist')

console.log('upload HTTP path tests passed')
