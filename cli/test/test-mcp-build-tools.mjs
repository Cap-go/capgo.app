#!/usr/bin/env node
/**
 * End-to-end of the MCP build tool surface: registers start_capgo_build /
 * capgo_build_wait / capgo_build_logs / cancel_capgo_build onto a fake MCP
 * server and drives the whole flow through the REAL tool handlers + REAL
 * rendering + REAL build-job manager, with only the build mechanics (spawn /
 * record / log file / clock) faked.
 *
 * Pins the agent-facing contract: the directive chain (start → wait → on
 * complete hand back to checkBuild; on fail → logs), the "watch logs" surfacing,
 * idempotency, and graceful no-appId handling.
 */
import process from 'node:process'

console.log('🧪 Testing MCP build tools (end-to-end tool surface)...\n')

const { registerBuildTools } = await import('../src/build/onboarding/mcp/build-tools.ts')
const { clearAllBuildJobs } = await import('../src/build/onboarding/mcp/build-job.ts')

let pass = 0
let fail = 0
async function test(name, fn) {
  try { clearAllBuildJobs(); console.log(`\n🔍 ${name}`); await fn(); console.log(`✅ PASSED: ${name}`); pass++ }
  catch (e) { console.error(`❌ FAILED: ${name}`); console.error(`   ${e.message}`); fail++ }
}
function ok(c, msg) { if (!c) throw new Error(msg || 'expected truthy') }
function has(text, sub, msg) { if (!String(text).includes(sub)) throw new Error(msg || `expected text to contain ${JSON.stringify(sub)} — got: ${String(text).slice(0, 200)}`) }

// Register the tools onto a fake server and return the captured handlers.
function setup(opts = {}) {
  const appId = Object.prototype.hasOwnProperty.call(opts, 'appId') ? opts.appId : 'com.acme.app'
  const tools = {}
  const server = { registerTool: (name, _config, handler) => { tools[name] = handler } }
  const state = { record: null, log: '', clock: 0, spawnCount: 0, lastChild: null }
  const deps = {
    spawnBuild: () => {
      state.spawnCount++
      let res
      const exited = new Promise((r) => { res = r })
      const c = { pid: 1, kill() {}, exited, _exit: res }
      state.lastChild = c
      return c
    },
    buildRecordPath: (a, p) => `/rec/${p}/${a}.json`,
    readBuildRecord: async () => {
      if (state.record === 'THROW')
        throw new Error('corrupt')
      return state.record
    },
    clearBuildRecord: async () => {},
    logPath: (a, p) => `/logs/${p}/${a}.log`,
    readLogSlice: async (_p, cursor) => ({ text: state.log.slice(cursor), nextCursor: state.log.length, eof: true }),
    sleep: async (ms) => { state.clock += ms },
    now: () => state.clock,
  }
  registerBuildTools(server, async () => appId, deps)
  const call = async (name, args) => (await tools[name](args)).content[0].text
  return { tools, call, state }
}

await test('all four build tools are registered', async () => {
  const { tools } = setup()
  for (const name of ['start_capgo_build', 'capgo_build_wait', 'capgo_build_logs', 'cancel_capgo_build'])
    ok(typeof tools[name] === 'function', `tool ${name} must be registered`)
})

await test('start_capgo_build → build-launched, surfaces the log path, points at capgo_build_wait', async () => {
  const { call, state } = setup()
  const text = await call('start_capgo_build', { platform: 'android' })
  has(text, 'build-launched')
  has(text, '/logs/android/com.acme.app.log', 'must surface the user log path')
  has(text, 'capgo_build_wait', 'next must be capgo_build_wait')
  has(text, 'android:com.acme.app', 'carries the job_id')
  ok(state.spawnCount === 1, 'spawned exactly one build')
})

await test('start is idempotent: a second start does not spawn again', async () => {
  const { call, state } = setup()
  await call('start_capgo_build', { platform: 'android' })
  const text = await call('start_capgo_build', { platform: 'android' })
  has(text, 'already running')
  ok(state.spawnCount === 1, 'must not spawn a second build')
})

await test('capgo_build_wait while running → build-waiting, tells the agent to call wait again', async () => {
  const { call } = setup()
  await call('start_capgo_build', { platform: 'android' })
  const text = await call('capgo_build_wait', { job_id: 'android:com.acme.app', timeout_seconds: 2 })
  has(text, 'build-waiting')
  has(text, 'capgo_build_wait', 'must instruct to call wait again')
  has(text, 'still', 'tells the user it is still building')
})

await test('capgo_build_wait on success → build-complete, hands back to next_step checkBuild', async () => {
  const { call, state } = setup()
  await call('start_capgo_build', { platform: 'android' })
  state.record = { schemaVersion: 1, jobId: 'cloud-1', appId: 'com.acme.app', platform: 'android', buildMode: 'release', status: 'success', outputUrl: 'https://dl/app.apk', qrCodeAscii: '▓', qrCodePngPath: null, finishedAt: 'now' }
  const text = await call('capgo_build_wait', { job_id: 'android:com.acme.app', timeout_seconds: 2 })
  has(text, 'build-complete')
  has(text, 'https://dl/app.apk', 'shares the download url')
  has(text, 'checkBuild', 'routes back into the onboarding tail via checkBuild')
  has(text, 'capgo_builder_onboarding_next_step')
})

await test('capgo_build_wait on failure → build-failed, points at capgo_build_logs', async () => {
  const { call, state } = setup()
  await call('start_capgo_build', { platform: 'android' })
  state.record = { schemaVersion: 1, jobId: 'c', appId: 'com.acme.app', platform: 'android', buildMode: 'release', status: 'failed', outputUrl: null, qrCodeAscii: null, qrCodePngPath: null, finishedAt: 'now' }
  const text = await call('capgo_build_wait', { job_id: 'android:com.acme.app', timeout_seconds: 2 })
  has(text, 'build-failed')
  has(text, 'capgo_build_logs', 'next must be the logs tool to diagnose')
})

await test('capgo_build_logs returns the new log text + a cursor and a "summarize" reminder', async () => {
  const { call, state } = setup()
  await call('start_capgo_build', { platform: 'android' })
  state.log = 'compiling…\nlinking…\n'
  const text = await call('capgo_build_logs', { job_id: 'android:com.acme.app', cursor: 0 })
  has(text, 'compiling')
  has(text, 'next_cursor')
  has(text, 'Summarize', 'reminds the agent not to paste verbatim')
})

await test('cancel_capgo_build stops watching and reports it', async () => {
  const { call } = setup()
  await call('start_capgo_build', { platform: 'android' })
  const text = await call('cancel_capgo_build', { job_id: 'android:com.acme.app' })
  has(text, 'build-skipped')
  has(text, 'Stopped watching')
})

await test('start_capgo_build with no app id → graceful error, no spawn', async () => {
  const { call, state } = setup({ appId: undefined })
  const text = await call('start_capgo_build', { platform: 'android' })
  has(text, 'no Capgo app id')
  ok(state.spawnCount === 0, 'must not spawn without an app id')
})

console.log(`\n📊 Results: ${pass} passed, ${fail} failed`)
if (fail > 0)
  process.exit(1)
