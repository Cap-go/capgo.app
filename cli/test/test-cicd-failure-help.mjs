#!/usr/bin/env node
// cli/test/test-cicd-failure-help.mjs
//
// Covers the CI/CD build-failure help feature:
//   - decideCiFailureActions: the pure decision seam for the non-interactive
//     failure path (--ai-analytics and --send-logs are independent + additive;
//     neither flag → a discoverability tip instead of a silent failure).
//   - uploadSupportLogs: the success / graceful-fallback paths the --send-logs
//     flow depends on (the same primitive the inline runSendLogs helper calls).
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CI_FAILURE_TIP,
  decideCiFailureActions,
  shouldPrintCiTip,
} from '../src/ai/analyze.ts'
import { uploadSupportLogs } from '../src/support/support-upload.ts'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    process.stdout.write(`✓ ${name}\n`)
    passed++
  }
  catch (e) {
    process.stderr.write(`✗ ${name}\n   ${e.message}\n`)
    failed++
  }
}

// ---- (a) non-interactive + no flags -> tip is produced, no actions run ----
await test('no flags -> tip produced, neither action runs', () => {
  const a = decideCiFailureActions({ aiAnalyticsFlag: false, sendLogsFlag: false })
  assert.equal(a.runAiAnalysis, false)
  assert.equal(a.sendLogs, false)
  assert.equal(a.tip, CI_FAILURE_TIP)
  // The tip must surface BOTH escape hatches so CI users can discover them.
  assert.ok(a.tip.includes('--ai-analytics'), 'tip mentions --ai-analytics')
  assert.ok(a.tip.includes('--send-logs-to-support'), 'tip mentions --send-logs-to-support')
})

// ---- (b) --send-logs -> only the upload action runs, no tip ----
await test('--send-logs only -> sendLogs action runs, AI off, no tip', () => {
  const a = decideCiFailureActions({ aiAnalyticsFlag: false, sendLogsFlag: true })
  assert.equal(a.sendLogs, true)
  assert.equal(a.runAiAnalysis, false)
  assert.equal(a.tip, null)
})

// ---- --ai-analytics only -> only the AI action runs, no tip ----
await test('--ai-analytics only -> AI runs, sendLogs off, no tip', () => {
  const a = decideCiFailureActions({ aiAnalyticsFlag: true, sendLogsFlag: false })
  assert.equal(a.runAiAnalysis, true)
  assert.equal(a.sendLogs, false)
  assert.equal(a.tip, null)
})

// ---- (c) --ai-analytics + --send-logs -> BOTH run, no tip ----
await test('both flags -> both actions run, no tip', () => {
  const a = decideCiFailureActions({ aiAnalyticsFlag: true, sendLogsFlag: true })
  assert.equal(a.runAiAnalysis, true)
  assert.equal(a.sendLogs, true)
  assert.equal(a.tip, null)
})

// ---- shouldPrintCiTip: the reachable emit-site predicate ----
// The tip prints at the build-failure point (independent of log capture) ONLY
// for a non-interactive build where the user passed neither flag. Every other
// combination is false: interactive uses the clack menu, and a set flag means
// the corresponding action runs instead of the tip.
await test('shouldPrintCiTip -> true only for non-TTY + neither flag', () => {
  // The one true case.
  assert.equal(shouldPrintCiTip({ isTTY: false, aiAnalytics: false, sendLogs: false }), true)
  // Interactive: never (clack menu handles it).
  assert.equal(shouldPrintCiTip({ isTTY: true, aiAnalytics: false, sendLogs: false }), false)
  // A flag is set: the action runs, no tip.
  assert.equal(shouldPrintCiTip({ isTTY: false, aiAnalytics: true, sendLogs: false }), false)
  assert.equal(shouldPrintCiTip({ isTTY: false, aiAnalytics: false, sendLogs: true }), false)
  assert.equal(shouldPrintCiTip({ isTTY: false, aiAnalytics: true, sendLogs: true }), false)
  // Interactive + flags: still never.
  assert.equal(shouldPrintCiTip({ isTTY: true, aiAnalytics: true, sendLogs: false }), false)
  assert.equal(shouldPrintCiTip({ isTTY: true, aiAnalytics: false, sendLogs: true }), false)
  assert.equal(shouldPrintCiTip({ isTTY: true, aiAnalytics: true, sendLogs: true }), false)
})

// ---- (b cont.) the --send-logs upload primitive: success path ----
await test('uploadSupportLogs returns {id,url} on a 200 with a valid body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capgo-sendlogs-'))
  const gzPath = join(dir, 'bundle.log.gz')
  writeFileSync(gzPath, Buffer.from('gzipped-bytes'))

  let captured = null
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captured = { url, init }
    return new Response(
      JSON.stringify({ id: 'sup-123', url: 'https://capgo.app/logs/sup-123' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const r = await uploadSupportLogs({
      apiHost: 'https://api.test',
      apikey: 'apikey-abc',
      appId: 'com.app',
      jobId: 'job-1',
      platform: 'ios',
      gzPath,
    })
    assert.deepEqual(r, { id: 'sup-123', url: 'https://capgo.app/logs/sup-123' })
    assert.equal(captured.url, 'https://api.test/build/support_logs')
    assert.equal(captured.init.method, 'POST')
    assert.equal(captured.init.headers.capgkey, 'apikey-abc')
    const body = JSON.parse(captured.init.body)
    assert.equal(body.appId, 'com.app')
    assert.equal(body.jobId, 'job-1')
    assert.equal(body.platform, 'ios')
    assert.ok(typeof body.gzB64 === 'string' && body.gzB64.length > 0, 'sends base64 bundle')
  }
  finally {
    globalThis.fetch = origFetch
  }
})

// ---- (b cont.) the --send-logs upload primitive: graceful fallback (null) ----
await test('uploadSupportLogs returns null on a non-200 (graceful fallback)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capgo-sendlogs-'))
  const gzPath = join(dir, 'bundle.log.gz')
  writeFileSync(gzPath, Buffer.from('gzipped-bytes'))

  const origFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('rate limited', { status: 429 })
  try {
    const r = await uploadSupportLogs({
      apiHost: 'https://api.test',
      apikey: 'k',
      appId: 'com.app',
      jobId: 'job-1',
      gzPath,
    })
    assert.equal(r, null, 'a non-200 must degrade to null, never throw')
  }
  finally {
    globalThis.fetch = origFetch
  }
})

// ---- (b cont.) the --send-logs upload primitive: malformed 200 body (null) ----
await test('uploadSupportLogs returns null on a 200 with an invalid body shape', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capgo-sendlogs-'))
  const gzPath = join(dir, 'bundle.log.gz')
  writeFileSync(gzPath, Buffer.from('gzipped-bytes'))

  const origFetch = globalThis.fetch
  // id is a number, not a string — the response is 200 but the body fails
  // validation, so the primitive must degrade to null rather than throw.
  globalThis.fetch = async () => new Response(
    JSON.stringify({ id: 123, url: 'https://capgo.app/logs/123' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
  try {
    const r = await uploadSupportLogs({
      apiHost: 'https://api.test',
      apikey: 'k',
      appId: 'com.app',
      jobId: 'job-1',
      gzPath,
    })
    assert.equal(r, null, 'a malformed 200 body must degrade to null, never throw')
  }
  finally {
    globalThis.fetch = origFetch
  }
})

await test('uploadSupportLogs returns null when the gz file is missing (never throws)', async () => {
  const r = await uploadSupportLogs({
    apiHost: 'https://api.test',
    apikey: 'k',
    appId: 'com.app',
    jobId: 'job-1',
    gzPath: '/nonexistent/path/bundle.log.gz',
  })
  assert.equal(r, null)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
