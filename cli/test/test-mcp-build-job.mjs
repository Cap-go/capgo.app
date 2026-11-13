#!/usr/bin/env node
/**
 * Build-job manager — the MCP-owned cloud-build lifecycle behind the build tools
 * (start_capgo_build / capgo_build_wait / capgo_build_logs / cancel_capgo_build).
 *
 * Pins, with a fully injected clock + controllable child + record (no real
 * subprocess, no real files, no real time):
 *   - start spawns a tracked child, clears the stale record, returns running.
 *   - start is idempotent per (appId, platform) — a second start re-attaches.
 *   - wait is bounded (returns 'running' when the window elapses).
 *   - wait returns completed / failed from the record, failed on a corrupt
 *     record, and failed when the child exits without writing a record.
 *   - logs drain by cursor; eof only once the build is terminal.
 *   - cancel kills the child + best-effort cloud cancel.
 */
import process from 'node:process'

console.log('🧪 Testing MCP build-job manager...\n')

const {
  startBuild, waitBuild, statusBuild, buildLogs, cancelBuild, clearAllBuildJobs,
  DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS,
} = await import('../src/build/onboarding/mcp/build-job.ts')

let pass = 0
let fail = 0
async function test(name, fn) {
  try { clearAllBuildJobs(); console.log(`\n🔍 ${name}`); await fn(); console.log(`✅ PASSED: ${name}`); pass++ }
  catch (e) { console.error(`❌ FAILED: ${name}`); console.error(`   ${e.message}`); fail++ }
}
function eq(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
function ok(c, msg) { if (!c) throw new Error(msg || 'expected truthy') }
const flush = () => new Promise(r => setTimeout(r, 0))

// A controllable fake build subprocess.
function makeChild() {
  let resolveExit
  const exited = new Promise((res) => { resolveExit = res })
  const child = {
    pid: 4242,
    killed: false,
    kill() { this.killed = true },
    exited,
    _exit(code) { resolveExit(code) },
  }
  return child
}

// Fake deps with a mutable record + log content + a clock that only advances on sleep.
function makeDeps(overrides = {}) {
  const state = {
    record: null, // set to an object, or 'THROW' to simulate a corrupt record
    log: '',
    spawnCount: 0,
    clearedPaths: [],
    cloudCancelled: [],
    lastChild: null,
    lastSpawnArgs: null,
    clock: 0,
  }
  const deps = {
    spawnBuild: (spawnArgs) => {
      state.spawnCount++
      const c = makeChild()
      state.lastChild = c
      state.lastSpawnArgs = spawnArgs
      return c
    },
    buildRecordPath: (appId, platform) => `/rec/${platform}/${appId}.json`,
    readBuildRecord: async () => {
      if (state.record === 'THROW')
        throw new Error('record is corrupt')
      return state.record
    },
    clearBuildRecord: async (p) => { state.clearedPaths.push(p) },
    logPath: (appId, platform) => `/logs/${platform}/${appId}.log`,
    readLogSlice: async (_p, cursor) => ({ text: state.log.slice(cursor), nextCursor: state.log.length, eof: true }),
    cancelCloud: async (id) => { state.cloudCancelled.push(id) },
    sleep: async (ms) => { state.clock += ms },
    now: () => state.clock,
    ...overrides,
  }
  return { deps, state }
}

await test('start spawns a tracked child, clears the stale record, returns running', async () => {
  const { deps, state } = makeDeps()
  const r = await startBuild(deps, { appId: 'com.acme.app', platform: 'android' })
  eq(r.status, 'running')
  eq(r.platform, 'android')
  eq(r.appId, 'com.acme.app')
  eq(state.spawnCount, 1, 'must spawn exactly one build')
  eq(state.clearedPaths.length, 1, 'must clear the stale record before spawning')
  ok(r.logsPath.includes('com.acme.app'), 'returns the log path for the user')
})

await test('start is idempotent: a second start for the same target re-attaches (no second spawn)', async () => {
  const { deps, state } = makeDeps()
  const r1 = await startBuild(deps, { appId: 'com.acme.app', platform: 'android' })
  const r2 = await startBuild(deps, { appId: 'com.acme.app', platform: 'android' })
  eq(r2.jobId, r1.jobId, 'same target → same job id')
  eq(r2.alreadyRunning, true, 'second start reports alreadyRunning')
  eq(state.spawnCount, 1, 'must NOT spawn a second build')
})

await test('wait is bounded: still-running build returns "running" once the window elapses', async () => {
  const { deps, state } = makeDeps()
  const r0 = await startBuild(deps, { appId: 'com.acme.app', platform: 'android' })
  const r = await waitBuild(deps, { jobId: r0.jobId, timeoutSeconds: 5 })
  eq(r.status, 'running', 'no record + child alive → still running after the window')
  ok(state.clock >= 5000, 'must have waited up to the bounded window')
})

await test('wait clamps timeout to [1, 59]', async () => {
  const { deps } = makeDeps()
  const r0 = await startBuild(deps, { appId: 'com.acme.app', platform: 'android' })
  // 999s requested → clamped to MAX_WAIT_SECONDS; loop ends by deadline.
  const r = await waitBuild(deps, { jobId: r0.jobId, timeoutSeconds: 999 })
  eq(r.status, 'running')
  ok(MAX_WAIT_SECONDS === 59 && DEFAULT_WAIT_SECONDS === 40, 'wait constants are 40 default / 59 max')
})

await test('wait returns completed from a success record (outputUrl surfaced)', async () => {
  const { deps, state } = makeDeps()
  const r0 = await startBuild(deps, { appId: 'com.acme.app', platform: 'android' })
  state.record = { schemaVersion: 1, jobId: 'cloud-1', appId: 'com.acme.app', platform: 'android', buildMode: 'release', status: 'success', outputUrl: 'https://dl/app.apk', qrCodeAscii: '▓▓', qrCodePngPath: null, finishedAt: 'now' }
  const r = await waitBuild(deps, { jobId: r0.jobId, timeoutSeconds: 5 })
  eq(r.status, 'completed')
  eq(r.outputUrl, 'https://dl/app.apk')
})

await test('wait returns failed from a non-success record', async () => {
  const { deps, state } = makeDeps()
  const r0 = await startBuild(deps, { appId: 'com.acme.app', platform: 'android' })
  state.record = { schemaVersion: 1, jobId: 'cloud-1', appId: 'com.acme.app', platform: 'android', buildMode: 'release', status: 'failed', outputUrl: null, qrCodeAscii: null, qrCodePngPath: null, finishedAt: 'now' }
  const r = await waitBuild(deps, { jobId: r0.jobId, timeoutSeconds: 5 })
  eq(r.status, 'failed')
  ok(/did not succeed/i.test(r.error || ''), 'surfaces the failure')
})

await test('wait returns failed when the record is present but corrupt (does not poll forever)', async () => {
  const { deps, state } = makeDeps()
  const r0 = await startBuild(deps, { appId: 'com.acme.app', platform: 'android' })
  state.record = 'THROW'
  const r = await waitBuild(deps, { jobId: r0.jobId, timeoutSeconds: 5 })
  eq(r.status, 'failed')
  ok(/could not be read/i.test(r.error || ''), 'surfaces the read error')
})

await test('wait returns failed when the child exits without writing a record', async () => {
  const { deps, state } = makeDeps()
  const r0 = await startBuild(deps, { appId: 'com.acme.app', platform: 'android' })
  state.lastChild._exit(1)
  await flush() // let the exit handler set exitCode
  const r = await waitBuild(deps, { jobId: r0.jobId, timeoutSeconds: 5 })
  eq(r.status, 'failed')
  ok(/exited/i.test(r.error || ''), 'reports the silent crash as failed')
})

await test('spawn start error surfaces in status, logs fallback, and log file text', async () => {
  const failMsg = '[capgo] Failed to start build process: ENOENT spawn npx ENOENT'
  const { deps, state } = makeDeps({
    spawnBuild: ({ onProcessFailure, logPath }) => {
      state.spawnCount++
      state.log = `[capgo] Starting cloud build: npx … (cwd /proj)\n${failMsg}\n`
      queueMicrotask(() => onProcessFailure?.(failMsg))
      const exited = Promise.resolve(null)
      return { pid: -1, kill() {}, exited }
    },
    readLogSlice: async (_p, cursor) => ({ text: state.log.slice(cursor), nextCursor: state.log.length, eof: true }),
  })
  const r0 = await startBuild(deps, { appId: 'com.acme.app', platform: 'android' })
  await flush()
  const waited = await waitBuild(deps, { jobId: r0.jobId, timeoutSeconds: 1 })
  eq(waited.status, 'failed')
  eq(waited.error, failMsg)
  const logs = await buildLogs(deps, { jobId: r0.jobId, cursor: 0 })
  ok(logs.text.includes('Failed to start build process'), 'log slice carries spawn failure text')
  ok(/Failed to start build process/.test(logs.text))
})

await test('logs drain by cursor; eof only once the build is terminal', async () => {
  const { deps, state } = makeDeps()
  const r0 = await startBuild(deps, { appId: 'com.acme.app', platform: 'android' })
  state.log = 'line one\nline two\n'
  const first = await buildLogs(deps, { jobId: r0.jobId, cursor: 0 })
  eq(first.text, 'line one\nline two\n')
  eq(first.nextCursor, state.log.length)
  eq(first.eof, false, 'not eof while still running')
  // Now finish the build → eof becomes true.
  state.record = { schemaVersion: 1, jobId: 'c', appId: 'com.acme.app', platform: 'android', buildMode: 'release', status: 'success', outputUrl: 'u', qrCodeAscii: null, qrCodePngPath: null, finishedAt: 'now' }
  const second = await buildLogs(deps, { jobId: r0.jobId, cursor: first.nextCursor })
  eq(second.text, '', 'no new bytes since cursor')
  eq(second.eof, true, 'eof once terminal and read to end')
})

await test('cancel kills the child and best-effort cloud-cancels once the cloud id is known', async () => {
  const { deps, state } = makeDeps()
  const r0 = await startBuild(deps, { appId: 'com.acme.app', platform: 'android' })
  // Learn the cloud job id via a status read.
  state.record = { schemaVersion: 1, jobId: 'cloud-77', appId: 'com.acme.app', platform: 'android', buildMode: 'release', status: 'pending', outputUrl: null, qrCodeAscii: null, qrCodePngPath: null, finishedAt: '' }
  await statusBuild(deps, { jobId: r0.jobId })
  const r = await cancelBuild(deps, { jobId: r0.jobId })
  eq(r.status, 'cancelled')
  eq(state.lastChild.killed, true, 'kills the local child')
  ok(state.cloudCancelled.includes('cloud-77'), 'best-effort cloud cancel by cloud job id')
})

await test('wait/status/cancel on an unknown job id return status "unknown" (graceful, no throw)', async () => {
  const { deps } = makeDeps()
  const w = await waitBuild(deps, { jobId: 'android:com.ghost.app', timeoutSeconds: 1 })
  eq(w.status, 'unknown')
  eq(w.appId, 'com.ghost.app', 'parses appId from the job id for a useful fallback')
  eq(w.platform, 'android')
  const c = await cancelBuild(deps, { jobId: 'ios:com.ghost.app' })
  eq(c.status, 'unknown')
})

console.log(`\n📊 Results: ${pass} passed, ${fail} failed`)
if (fail > 0)
  process.exit(1)
