#!/usr/bin/env node

import assert from 'node:assert/strict'

console.log('🧪 Testing build stream custom messages...\n')

const { handleCustomMsg } = await import('../src/build/qr.ts')

async function run(kind, data) {
  const logs = []
  const warns = []
  await handleCustomMsg(kind, data, line => logs.push(line), line => warns.push(line))
  return { logs, warns }
}

const step = await run('step', { action: 'android_aab_build', status: 'started', ts: 1 })
assert.deepEqual(step, { logs: [], warns: [] }, 'step messages are ignored silently')

const unknown = await run('something_new', { a: 1 })
assert.equal(unknown.warns.length, 1, 'unknown kinds still warn')

const qr = await run('qr_download_link', { url: 'https://example.com/app.apk' })
assert.ok(qr.logs.includes('https://example.com/app.apk'), 'download links still print')
assert.equal(qr.warns.length, 0)

console.log('✅ build custom messages')
