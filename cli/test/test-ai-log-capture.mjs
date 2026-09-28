#!/usr/bin/env node
import { existsSync, statSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendCapturedLine,
  cleanupCapturedJobFiles,
  createLogCaptureLifecycle,
  flushCapturedLogs,
  getLogCapturePath,
  shouldCaptureLogs,
  startCaptureForJob,
} from '../src/ai/log-capture.ts'
import { prepareBuildSupportLogBundle } from '../src/build/support-log-bundle.ts'
import { offerSupportUploadBeforeAi } from '../src/support/support-upload-prompt.ts'

let passed = 0
let failed = 0

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { console.log(`✅ ${name}`); passed++ })
    .catch((err) => { console.error(`❌ ${name}\n   ${err.message}`); failed++ })
}

const TEST_DIR = join(tmpdir(), `capgo-ai-test-${Date.now()}`)
const JOB_ID = 'job-test-abc'

await mkdir(TEST_DIR, { recursive: true })
process.env.CAPGO_AI_LOG_BASE_DIR = TEST_DIR // override /tmp/capgo-builds for tests

await test('getLogCapturePath returns expected path under override base dir', () => {
  const p = getLogCapturePath(JOB_ID)
  if (p !== join(TEST_DIR, `${JOB_ID}.log`))
    throw new Error(`unexpected path: ${p}`)
})

await test('shouldCaptureLogs returns false when not a TTY', () => {
  const orig = process.stdout.isTTY
  process.stdout.isTTY = false
  const result = shouldCaptureLogs()
  process.stdout.isTTY = orig
  if (result !== false)
    throw new Error(`expected false when not TTY, got ${result}`)
})

await test('shouldCaptureLogs returns true when stdout is TTY', () => {
  const orig = process.stdout.isTTY
  process.stdout.isTTY = true
  const result = shouldCaptureLogs()
  process.stdout.isTTY = orig
  if (result !== true)
    throw new Error(`expected true when TTY, got ${result}`)
})

await test('startCaptureForJob creates the directory and empty file', async () => {
  await startCaptureForJob(JOB_ID)
  const p = getLogCapturePath(JOB_ID)
  if (!existsSync(p))
    throw new Error(`log file not created at ${p}`)
  if (statSync(p).size !== 0)
    throw new Error(`expected empty file, size = ${statSync(p).size}`)
})

await test('appendCapturedLine appends lines with newlines', async () => {
  await startCaptureForJob(JOB_ID)
  appendCapturedLine(JOB_ID, 'first line')
  appendCapturedLine(JOB_ID, 'second line')
  await flushCapturedLogs(JOB_ID)
  const content = readFileSync(getLogCapturePath(JOB_ID), 'utf8')
  if (content !== 'first line\nsecond line\n')
    throw new Error(`unexpected content: ${JSON.stringify(content)}`)
})

await test('support bundle waits for delayed writes and keeps every streamed line in order', async () => {
  const jobId = 'job-race-regression'
  const lines = ['configure project', 'compile sources', 'terminal failure']
  let releaseWrites
  const writesReleased = new Promise((resolve) => { releaseWrites = resolve })
  const lifecycle = createLogCaptureLifecycle({
    appendFile: async (path, data, options) => {
      await writesReleased
      await appendFile(path, data, options)
    },
  })

  await lifecycle.startCaptureForJob(jobId)
  for (const line of lines)
    lifecycle.appendCapturedLine(jobId, line)

  let bundleSettled = false
  const bundlePromise = prepareBuildSupportLogBundle({
    appId: 'com.example.capture-race',
    jobId,
    outputDir: TEST_DIR,
  }, {
    readCapturedLog: lifecycle.readCapturedLog,
    readInternalLog: async () => '',
  }).then((files) => {
    bundleSettled = true
    return files
  })

  await new Promise(resolve => setImmediate(resolve))
  if (bundleSettled)
    throw new Error('bundle creation completed before pending writes drained')

  releaseWrites()
  const files = await bundlePromise
  if (!files)
    throw new Error('support bundle was not created')

  const bundle = readFileSync(files.logPath, 'utf8')
  const recentLogsIndex = bundle.indexOf('Recent logs:')
  if (recentLogsIndex < 0)
    throw new Error('bundle is missing the Recent logs section')
  const recentLogs = bundle.slice(recentLogsIndex)
  let previousIndex = -1
  for (const line of lines) {
    const firstIndex = recentLogs.indexOf(line)
    if (firstIndex <= previousIndex)
      throw new Error(`line is missing or out of order: ${line}`)
    if (recentLogs.indexOf(line, firstIndex + line.length) !== -1)
      throw new Error(`line appears more than once: ${line}`)
    previousIndex = firstIndex
  }

  await lifecycle.cleanupCapturedJobFiles(jobId, { keepAiPromptFile: false })
})

await test('capture write failure prevents a misleading support upload', async () => {
  const jobId = 'job-write-failure'
  const lifecycle = createLogCaptureLifecycle({
    appendFile: async () => { throw new Error('simulated append failure') },
  })
  await lifecycle.startCaptureForJob(jobId)
  lifecycle.appendCapturedLine(jobId, 'important failure detail')

  let uploadCalled = false
  const printed = []
  const outcome = await offerSupportUploadBeforeAi({
    confirm: async () => true,
    buildFiles: () => prepareBuildSupportLogBundle({
      appId: 'com.example.write-failure',
      jobId,
      outputDir: TEST_DIR,
    }, {
      readCapturedLog: lifecycle.readCapturedLog,
      readInternalLog: async () => '',
    }),
    upload: async () => {
      uploadCalled = true
      return { id: 'fake-upload', url: 'https://example.invalid/fake-upload' }
    },
    print: message => printed.push(message),
  })

  if (outcome !== 'failed')
    throw new Error(`expected failed outcome, got ${outcome}`)
  if (uploadCalled)
    throw new Error('upload must not run after a captured-log write failure')
  if (!printed.some(message => /couldn.t prepare/i.test(message)))
    throw new Error('capture failure was not surfaced to the user')

  await lifecycle.cleanupCapturedJobFiles(jobId, { keepAiPromptFile: false })
})

await test('capture read failure prevents a misleading support upload', async () => {
  const jobId = 'job-read-failure'
  const lifecycle = createLogCaptureLifecycle({
    readFile: async () => { throw new Error('simulated read failure') },
  })
  await lifecycle.startCaptureForJob(jobId)

  let uploadCalled = false
  const outcome = await offerSupportUploadBeforeAi({
    confirm: async () => true,
    buildFiles: () => prepareBuildSupportLogBundle({
      appId: 'com.example.read-failure',
      jobId,
      outputDir: TEST_DIR,
    }, {
      readCapturedLog: lifecycle.readCapturedLog,
      readInternalLog: async () => '',
    }),
    upload: async () => {
      uploadCalled = true
      return { id: 'fake-upload', url: 'https://example.invalid/fake-upload' }
    },
    print: () => {},
  })

  if (outcome !== 'failed')
    throw new Error(`expected failed outcome, got ${outcome}`)
  if (uploadCalled)
    throw new Error('upload must not run after a captured-log read failure')

  await lifecycle.cleanupCapturedJobFiles(jobId, { keepAiPromptFile: false })
})

await test('cleanup waits for pending writes before deleting the capture', async () => {
  const jobId = 'job-cleanup-race'
  let releaseWrite
  const writeReleased = new Promise((resolve) => { releaseWrite = resolve })
  let logDeleted = false
  const lifecycle = createLogCaptureLifecycle({
    appendFile: async (path, data, options) => {
      await writeReleased
      await appendFile(path, data, options)
    },
    unlink: async (path) => {
      if (path === getLogCapturePath(jobId))
        logDeleted = true
      await unlink(path)
    },
  })

  await lifecycle.startCaptureForJob(jobId)
  lifecycle.appendCapturedLine(jobId, 'last streamed line')
  const cleanupPromise = lifecycle.cleanupCapturedJobFiles(jobId, { keepAiPromptFile: false })

  await new Promise(resolve => setImmediate(resolve))
  if (logDeleted)
    throw new Error('cleanup deleted the capture before its pending write completed')

  releaseWrite()
  await cleanupPromise
  if (!logDeleted)
    throw new Error('cleanup did not delete the capture after draining writes')
})

await test('cleanupCapturedJobFiles removes the log file', async () => {
  await startCaptureForJob(JOB_ID)
  await appendCapturedLine(JOB_ID, 'something')
  await cleanupCapturedJobFiles(JOB_ID, { keepAiPromptFile: false })
  if (existsSync(getLogCapturePath(JOB_ID)))
    throw new Error('log file should have been deleted')
})

await test('cleanupCapturedJobFiles is idempotent (no throw when file missing)', async () => {
  await cleanupCapturedJobFiles(JOB_ID, { keepAiPromptFile: false })
  await cleanupCapturedJobFiles(JOB_ID, { keepAiPromptFile: false }) // second call
  // no error = pass
})

await test('cleanupCapturedJobFiles with keepAiPromptFile=true preserves .ai-prompt.txt', async () => {
  await startCaptureForJob(JOB_ID)
  const promptPath = join(TEST_DIR, `${JOB_ID}.ai-prompt.txt`)
  // simulate that local-AI flow wrote this file
  await writeFile(promptPath, 'prompt + logs')
  await cleanupCapturedJobFiles(JOB_ID, { keepAiPromptFile: true })
  if (existsSync(getLogCapturePath(JOB_ID)))
    throw new Error('log file should have been deleted')
  if (!existsSync(promptPath))
    throw new Error('.ai-prompt.txt should have been preserved')
})

await rm(TEST_DIR, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
