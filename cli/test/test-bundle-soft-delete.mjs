#!/usr/bin/env node

import assert from 'node:assert/strict'
import { deleteAppVersion } from '../src/api/versions.ts'

const originalFetch = globalThis.fetch
const client = { apikey: 'test-key', apiHost: 'http://127.0.0.1:8787', filesHost: 'http://127.0.0.1:8787' }

function respond(updated) {
  globalThis.fetch = async () => new Response(JSON.stringify({ updated }), { status: 200, headers: { 'content-type': 'application/json' } })
}

try {
  respond(['1.0.0'])
  await deleteAppVersion(client, 'com.example.app', '1.0.0', { silent: true })

  // Zero rows updated (already deleted, renamed, not visible) is a failure, not a silent success.
  respond([])
  await assert.rejects(
    () => deleteAppVersion(client, 'com.example.app', '1.0.0', { silent: true }),
    /App version com\.example\.app@1\.0\.0 not found/,
  )

  console.log('bundle soft-delete tests passed')
}
finally {
  globalThis.fetch = originalFetch
}
