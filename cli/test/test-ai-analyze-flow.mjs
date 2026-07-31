#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  decideAnalyzeBehavior,
  writeLocalAiFile,
  postAnalyzeStreamRequest,
} from '../src/ai/analyze.ts'
import { SYSTEM_PROMPT } from '../src/ai/prompt.ts'

let passed = 0
let failed = 0

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { console.log(`✅ ${name}`); passed++ })
    .catch((err) => { console.error(`❌ ${name}\n   ${err.message}`); failed++ })
}

const TEST_DIR = join(tmpdir(), `capgo-ai-flow-test-${Date.now()}`)
const JOB_ID = 'job-flow-test'
await mkdir(TEST_DIR, { recursive: true })
process.env.CAPGO_AI_LOG_BASE_DIR = TEST_DIR

// ---- decideAnalyzeBehavior matrix ----
// Explicit opt-in (--ai-analytics OR --send-logs) always runs the action(s)
// directly without prompting, in ANY terminal. No flags: interactive gets the
// ask-then-menu flow, non-interactive stays silent (skip).
function expectBehavior(name, input, want) {
  return test(name, () => {
    const r = decideAnalyzeBehavior(input)
    if (r !== want) throw new Error(`got ${r}, want ${want}`)
  })
}

// TTY + --ai-analytics: was 'show_menu' (the bug); now runs directly.
await expectBehavior('matrix: TTY + ai-analytics → auto_upload', { isTTY: true, aiAnalyticsFlag: true, sendLogsFlag: false }, 'auto_upload')
await expectBehavior('matrix: TTY + send-logs → auto_upload', { isTTY: true, aiAnalyticsFlag: false, sendLogsFlag: true }, 'auto_upload')
await expectBehavior('matrix: TTY + both flags → auto_upload', { isTTY: true, aiAnalyticsFlag: true, sendLogsFlag: true }, 'auto_upload')
await expectBehavior('matrix: non-TTY + ai-analytics → auto_upload', { isTTY: false, aiAnalyticsFlag: true, sendLogsFlag: false }, 'auto_upload')
await expectBehavior('matrix: non-TTY + send-logs → auto_upload', { isTTY: false, aiAnalyticsFlag: false, sendLogsFlag: true }, 'auto_upload')
await expectBehavior('matrix: non-TTY + both flags → auto_upload', { isTTY: false, aiAnalyticsFlag: true, sendLogsFlag: true }, 'auto_upload')
await expectBehavior('matrix: TTY + no flags → ask_then_menu', { isTTY: true, aiAnalyticsFlag: false, sendLogsFlag: false }, 'ask_then_menu')
await expectBehavior('matrix: non-TTY + no flags → skip', { isTTY: false, aiAnalyticsFlag: false, sendLogsFlag: false }, 'skip')

await test('SYSTEM_PROMPT treats generated Fastlane configuration as Capgo-managed', () => {
  const requiredInstructions = [
    'Capgo owns and generates the Fastlane configuration',
    'Never tell the user to inspect, create, edit, remove, or\notherwise modify `fastlane/Fastfile`',
    'no project-side change is needed',
    'Capgo support with the job ID instead of proposing a repository edit',
  ]
  for (const instruction of requiredInstructions) {
    if (!SYSTEM_PROMPT.includes(instruction))
      throw new Error(`missing Capgo-managed Fastlane instruction: ${instruction}`)
  }
})

// ---- writeLocalAiFile ----
await test('writeLocalAiFile writes prompt + <BUILD_LOG> boundary + logs', async () => {
  await writeFile(join(TEST_DIR, `${JOB_ID}.log`), 'line1\nline2\n')
  const promptPath = await writeLocalAiFile(JOB_ID)
  if (!existsSync(promptPath))
    throw new Error(`prompt file not written at ${promptPath}`)
  const content = readFileSync(promptPath, 'utf8')
  if (!content.includes('You are a build engineer'))
    throw new Error('system prompt missing from local-AI file')
  if (!content.includes('<BUILD_LOG>') || !content.includes('</BUILD_LOG>'))
    throw new Error('BUILD_LOG boundary tags missing')
  if (!content.includes('line1\nline2'))
    throw new Error('log content missing')
})

// ---- postAnalyzeStreamRequest ----
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

await test('postAnalyzeStreamRequest sends POST with correct shape and returns analysis', async () => {
  let captured = null
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captured = { url, init }
    return sseResponse([
      'event: chunk\ndata: {"text":"### Likely cause\\ntest"}\n\n',
      'event: done\ndata: {"durationMs":1}\n\n',
    ])
  }

  try {
    const result = await postAnalyzeStreamRequest({
      apiHost: 'https://api.test',
      apikey: 'apikey-abc',
      jobId: JOB_ID,
      appId: 'com.app',
      logs: 'hello logs',
    })

    if (captured.url !== 'https://api.test/build/ai_analyze_stream')
      throw new Error(`url: ${captured.url}`)
    if (captured.init.method !== 'POST')
      throw new Error(`method: ${captured.init.method}`)
    if (captured.init.headers.capgkey !== 'apikey-abc')
      throw new Error('missing capgkey header')
    const body = JSON.parse(captured.init.body)
    if (body.jobId !== JOB_ID || body.appId !== 'com.app' || body.logs !== 'hello logs')
      throw new Error(`body shape wrong: ${JSON.stringify(body)}`)
    if (result.kind !== 'ok' || result.analysis !== '### Likely cause\ntest')
      throw new Error(`result: ${JSON.stringify(result)}`)
  }
  finally {
    // Always restore — a throw above must not leak the mocked fetch into
    // subsequent tests and fail them for the wrong reason.
    globalThis.fetch = origFetch
  }
})

await test('postAnalyzeStreamRequest returns already_analyzed on 409', async () => {
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: 'already_analyzed' }),
    { status: 409, headers: { 'content-type': 'application/json' } }
  )
  const result = await postAnalyzeStreamRequest({
    apiHost: 'x', apikey: 'y', jobId: JOB_ID, appId: 'a', logs: 'l',
  })
  if (result.kind !== 'already_analyzed')
    throw new Error(`got ${JSON.stringify(result)}`)
})

await test('postAnalyzeStreamRequest returns error on 5xx', async () => {
  globalThis.fetch = async () => new Response('upstream broken', { status: 503 })
  const result = await postAnalyzeStreamRequest({
    apiHost: 'x', apikey: 'y', jobId: JOB_ID, appId: 'a', logs: 'l',
  })
  if (result.kind !== 'error')
    throw new Error(`got ${JSON.stringify(result)}`)
})

await test('postAnalyzeStreamRequest returns too_big on 413', async () => {
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: 'logs_too_big' }),
    { status: 413, headers: { 'content-type': 'application/json' } },
  )
  const result = await postAnalyzeStreamRequest({
    apiHost: 'x', apikey: 'y', jobId: JOB_ID, appId: 'a', logs: 'l',
  })
  if (result.kind !== 'too_big')
    throw new Error(`got ${JSON.stringify(result)}`)
})

await rm(TEST_DIR, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
