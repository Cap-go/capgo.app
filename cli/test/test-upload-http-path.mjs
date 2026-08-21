#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function uploadHotPathSource(uploadSource) {
  const autoBumpStart = uploadSource.indexOf('const autoBumpInput = normalizeAutoBumpInput')
  const autoBumpEnd = uploadSource.indexOf('if (options.autoSetBundle)', autoBumpStart)
  if (autoBumpStart === -1 || autoBumpEnd === -1)
    return uploadSource
  return `${uploadSource.slice(0, autoBumpStart)}${uploadSource.slice(autoBumpEnd)}`
}

const uploadSource = readFileSync(new URL('../src/bundle/upload.ts', import.meta.url), 'utf8')
const utilsSource = readFileSync(new URL('../src/utils.ts', import.meta.url), 'utf8')
const uploadHotPath = uploadHotPathSource(uploadSource)

assert.doesNotMatch(uploadHotPath, /supabase\.from\(/, 'upload hot path must not call supabase.from')
assert.doesNotMatch(uploadHotPath, /supabase\.rpc\(/, 'upload hot path must not call supabase.rpc')
assert.doesNotMatch(uploadHotPath, /functions\.invoke\(/, 'upload hot path must not call functions.invoke')
assert.match(uploadSource, /updateOrCreateVersion\(ctx\.apikey/, 'upload must prepare versions via Capgo HTTP')
assert.match(uploadSource, /finishTusUploadVersion\(ctx\.apikey/, 'upload must finalize TUS via Capgo HTTP')
assert.match(utilsSource, /export async function checkPlanValidUploadViaHttp/, 'plan validation HTTP helper must exist')

console.log('upload HTTP path tests passed')
