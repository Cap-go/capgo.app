#!/usr/bin/env node
// Tests for the caller-handled AI flow used by the Ink onboarding wizard:
//   - runCapgoAiAnalysis (reads /tmp log, delegates to postAnalyzeStreamRequest)
//   - releaseCapturedLogs (best-effort cleanup wrapper)
// (The decideAnalyzeBehavior matrix lives in test-ai-analyze-flow.mjs.)
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HARD_LOG_SIZE_LIMIT,
  releaseCapturedLogs,
  runCapgoAiAnalysis,
} from '../src/ai/analyze.ts'

let passed = 0
let failed = 0

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { console.log(`✅ ${name}`); passed++ })
    .catch((err) => { console.error(`❌ ${name}\n   ${err.message}`); failed++ })
}

const TEST_DIR = join(tmpdir(), `capgo-ai-onboarding-test-${Date.now()}`)
await mkdir(TEST_DIR, { recursive: true })
process.env.CAPGO_AI_LOG_BASE_DIR = TEST_DIR

// ---- runCapgoAiAnalysis ----
function sseResponse(frames, status = 200) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f))
      controller.close()
    },
  })
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

await test('runCapgoAiAnalysis reads the captured log and posts to /build/ai_analyze_stream', async () => {
  const jobId = `job-ok-${Date.now()}`
  const logPath = join(TEST_DIR, `${jobId}.log`)
  await writeFile(logPath, 'pretend xcode log line 1\npretend xcode log line 2\n')

  let captured = null
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captured = { url, init }
    return sseResponse([
      'event: chunk\ndata: {"text":"### Likely cause\\nsigning"}\n\n',
      'event: done\ndata: {"durationMs":1}\n\n',
    ])
  }
  try {
    const result = await runCapgoAiAnalysis({
      apiHost: 'https://api.test',
      apikey: 'key',
      jobId,
      appId: 'com.test.app',
    })
    if (result.kind !== 'ok')
      throw new Error(`expected ok, got ${result.kind}`)
    if (!result.analysis.includes('signing'))
      throw new Error('analysis text not propagated')
    if (!captured)
      throw new Error('fetch was not called')
    if (!captured.url.endsWith('/build/ai_analyze_stream'))
      throw new Error(`unexpected url ${captured.url}`)
    const body = JSON.parse(captured.init.body)
    if (body.jobId !== jobId)
      throw new Error('jobId not forwarded')
    if (!body.logs.includes('pretend xcode'))
      throw new Error('log content not forwarded')
  }
  finally {
    globalThis.fetch = origFetch
  }
})

await test('runCapgoAiAnalysis forwards onChunk per streamed delta (wizard live preview)', async () => {
  const jobId = `job-chunks-${Date.now()}`
  await writeFile(join(TEST_DIR, `${jobId}.log`), 'log\n')

  const origFetch = globalThis.fetch
  globalThis.fetch = async () => sseResponse([
    'event: chunk\ndata: {"text":"### Likely"}\n\n',
    'event: chunk\ndata: {"text":" cause"}\n\n',
    'event: done\ndata: {"durationMs":1}\n\n',
  ])
  try {
    const chunks = []
    const result = await runCapgoAiAnalysis({
      apiHost: 'https://api.test',
      apikey: 'key',
      jobId,
      appId: 'com.test.app',
      onChunk: t => chunks.push(t),
    })
    if (result.kind !== 'ok')
      throw new Error(`expected ok, got ${result.kind}`)
    if (chunks.join('|') !== '### Likely| cause')
      throw new Error(`onChunk deltas wrong: ${JSON.stringify(chunks)}`)
  }
  finally {
    globalThis.fetch = origFetch
  }
})

await test('runCapgoAiAnalysis returns too_big when log exceeds HARD_LOG_SIZE_LIMIT', async () => {
  const jobId = `job-big-${Date.now()}`
  const logPath = join(TEST_DIR, `${jobId}.log`)
  // Write 1 byte over the limit. Using a Buffer keeps the test fast.
  const buf = Buffer.alloc(HARD_LOG_SIZE_LIMIT + 1, 'x')
  await writeFile(logPath, buf)

  let fetchCalled = false
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => {
    fetchCalled = true
    return new Response('', { status: 500 })
  }
  try {
    const result = await runCapgoAiAnalysis({
      apiHost: 'https://api.test',
      apikey: 'key',
      jobId,
      appId: 'com.test.app',
    })
    if (result.kind !== 'too_big')
      throw new Error(`expected too_big, got ${result.kind}`)
    if (fetchCalled)
      throw new Error('fetch should not be called for too-big logs')
  }
  finally {
    globalThis.fetch = origFetch
  }
})

await test('runCapgoAiAnalysis returns error when the captured log is missing', async () => {
  let fetchCalled = false
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => {
    fetchCalled = true
    return new Response('', { status: 500 })
  }
  try {
    const result = await runCapgoAiAnalysis({
      apiHost: 'https://api.test',
      apikey: 'key',
      jobId: `job-missing-${Date.now()}`,
      appId: 'com.test.app',
    })
    if (result.kind !== 'error')
      throw new Error(`expected error, got ${result.kind}`)
    if (fetchCalled)
      throw new Error('fetch should not be called when log file is missing')
  }
  finally {
    globalThis.fetch = origFetch
  }
})

// ---- releaseCapturedLogs ----
await test('releaseCapturedLogs deletes the captured log file', async () => {
  const jobId = `job-release-${Date.now()}`
  const logPath = join(TEST_DIR, `${jobId}.log`)
  await writeFile(logPath, 'some content')
  if (!existsSync(logPath))
    throw new Error('precondition: log file should exist')

  await releaseCapturedLogs(jobId)

  if (existsSync(logPath))
    throw new Error('log file should be deleted after releaseCapturedLogs')
})

await test('releaseCapturedLogs is best-effort when nothing exists', async () => {
  // Should not throw on a missing file.
  await releaseCapturedLogs(`job-noop-${Date.now()}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0)
  process.exit(1)
