import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, test } from 'bun:test'

const dir = mkdtempSync(join(tmpdir(), 'capgo-background-shutdown-'))
let harness
let runnerCount = 0

beforeAll(async () => {
  writeFileSync(join(dir, 'entry.ts'), `
    export { startOnboardingCheck } from ${JSON.stringify(fileURLToPath(new URL('../src/onboarding/background.ts', import.meta.url)))}
    export { waitForOnboardingChecks } from ${JSON.stringify(fileURLToPath(new URL('../src/onboarding/background-shutdown.ts', import.meta.url)))}
    export { getPendingOnboardingChecks } from ${JSON.stringify(fileURLToPath(new URL('../src/onboarding/background-workers.ts', import.meta.url)))}
  `)
  const build = await Bun.build({ entrypoints: [join(dir, 'entry.ts')], outdir: dir, target: 'node', format: 'esm' })
  assert.equal(build.success, true)
  harness = pathToFileURL(join(dir, 'entry.js')).href
  writeFileSync(join(dir, 'busy.mjs'), 'setInterval(() => {}, 10_000)')
  writeFileSync(join(dir, 'quick.mjs'), 'setTimeout(() => {}, 300)')
  writeFileSync(join(dir, 'slow.mjs'), 'setTimeout(() => {}, 900)')
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function run({ commandPath = 'app list', options = {}, tty = true, stdinTty = tty, stdoutTty = tty, ci = false, workers = ['busy.mjs'], foregroundMs = 0, previousInterrupt = false, telemetry = 'ok', disabled = false } = {}) {
  const source = `
    import { performance } from 'node:perf_hooks'
    import { startOnboardingCheck, waitForOnboardingChecks, getPendingOnboardingChecks } from ${JSON.stringify(harness)}
    Object.defineProperty(process.stdin, 'isTTY', { value: ${stdinTty} })
    Object.defineProperty(process.stdout, 'isTTY', { value: ${stdoutTty} })
    globalThis.fetch = async (url, init) => {
      if (!String(url).endsWith('/private/events'))
        return new Response('', { status: 500 })
      console.log('telemetry:' + init.body)
      if (${JSON.stringify(telemetry)} === 'reject')
        throw new Error('offline')
      if (${JSON.stringify(telemetry)} === 'hang') {
        return new Promise((resolve, reject) => {
          const abort = () => { console.log('telemetry-aborted'); reject(new Error('aborted')) }
          if (init.signal.aborted) abort()
          else init.signal.addEventListener('abort', abort, { once: true })
        })
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
    }
    const command = { optsWithGlobals: () => (${JSON.stringify({ apikey: 'fake-api-key', appId: 'com.example.ready', ...options })}), registeredArguments: [], args: [] }
    for (const filename of ${JSON.stringify(workers)})
      startOnboardingCheck(command, ${JSON.stringify(commandPath)}, new URL(filename, ${JSON.stringify(pathToFileURL(join(dir, 'run.mjs')).href)}))
    console.log('pending-attempts:' + JSON.stringify([...getPendingOnboardingChecks().values()].map(check => check.attemptId)))
    let foregroundInterrupts = 0
    if (${previousInterrupt}) {
      process.on('SIGINT', () => { foregroundInterrupts++; console.log('foreground-interrupted') })
      process.emit('SIGINT')
    }
    await new Promise(resolve => setTimeout(resolve, ${foregroundMs}))
    console.log('interrupt-count-before-wait:' + foregroundInterrupts)
    const started = performance.now()
    await waitForOnboardingChecks(command, ${JSON.stringify(commandPath)})
    console.log('foreground-finished:' + Math.round(performance.now() - started))
  `
  const runner = join(dir, `run-${++runnerCount}.mjs`)
  writeFileSync(runner, source)
  const child = spawn('node', [runner], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: ci ? 'true' : 'false', CAPGO_DISABLE_TELEMETRY: disabled ? 'true' : '', CAPGO_DISABLE_POSTHOG: '' } })
  let output = ''
  let errors = ''
  let waiting
  const waitingMessage = new Promise(resolve => { waiting = resolve })
  for (const [stream, stderr] of [[child.stdout, false], [child.stderr, true]]) {
    stream.on('data', chunk => {
      if (stderr) errors += chunk
      else output += chunk
      if ((output + errors).includes('Waiting for background checks')) waiting()
    })
  }
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000)
  const completion = once(child, 'exit').then(([code, signal]) => {
    clearTimeout(timeout)
    return { code, signal, output, errors, text: output + errors }
  })
  return { child, completion, waitingMessage }
}

function waitedMs(result) {
  assert.equal(result.code, 0, result.text)
  assert.equal(result.signal, null)
  return Number(result.output.match(/foreground-finished:(\d+)/)?.[1])
}

function waitEvents(result) {
  return result.output.split('\n').filter(line => line.startsWith('telemetry:')).map(line => JSON.parse(line.slice('telemetry:'.length)))
}

test.concurrent('both workers share one five-second shutdown budget', async () => {
  const { completion } = run({ workers: ['busy.mjs', 'busy.mjs'] })
  const result = await completion
  const duration = waitedMs(result)
  assert.ok(duration >= 4_900 && duration < 6_000, `shared wait was ${duration}ms`)
  assert.equal(result.text.match(/Waiting for background checks/g)?.length, 1)
  const events = waitEvents(result)
  assert.equal(events.length, 1)
  const event = events[0]
  assert.equal(event.event, 'background_checks_wait_started')
  assert.equal(event.channel, 'cli-usage')
  assert.equal(event.tracking_version, 2)
  assert.ok(Number.isFinite(Date.parse(event.timestamp)))
  assert.equal(event.nonPersonTags.command_path, 'app list')
  assert.equal(event.nonPersonTags.pending_checks, 2)
  assert.equal(event.nonPersonTags.grace_period_ms, 5_000)
  const attempts = JSON.parse(result.output.match(/pending-attempts:(.+)/)[1])
  assert.deepEqual(event.nonPersonTags.scan_attempt_ids, attempts)
  assert.equal(new Set(attempts).size, 2)
  for (const id of attempts) assert.match(id, /^[0-9a-f-]{36}$/)
  assert.equal(JSON.stringify(event).includes('fake-api-key'), false)
  assert.equal(JSON.stringify(event).includes(dir), false)
}, 12_000)

test.concurrent('exits early as soon as the last worker finishes', async () => {
  const result = await run({ workers: ['quick.mjs', 'slow.mjs'] }).completion
  const duration = waitedMs(result)
  assert.ok(duration >= 800 && duration < 2_000, `early completion was ${duration}ms`)
  assert.ok(result.text.includes('Waiting for background checks'))
})

test.concurrent('completed or absent checks produce no waiting message or delay', async () => {
  for (const settings of [{ workers: [] }, { workers: ['quick.mjs'], foregroundMs: 1_000 }]) {
    const result = await run(settings).completion
    assert.ok(waitedMs(result) < 100)
    assert.ok(!result.text.includes('Waiting for background checks'))
    assert.deepEqual(waitEvents(result), [])
  }
})

test.concurrent('SIGINT during the grace period exits immediately even after a previous interrupt', async () => {
  const { child, completion, waitingMessage } = run({ previousInterrupt: true })
  await Promise.race([waitingMessage, completion.then(() => { throw new Error('exited before entering the grace period') })])
  child.kill('SIGINT')
  const result = await completion
  assert.equal(result.code, 130)
  assert.equal(result.signal, null)
  const previousInterrupts = Number(result.output.match(/interrupt-count-before-wait:(\d+)/)[1])
  assert.ok(previousInterrupts >= 1)
  assert.equal(result.output.match(/foreground-interrupted/g)?.length, previousInterrupts, result.text)
  assert.ok(!result.text.includes('foreground-finished'))
})

test.concurrent('machine output, init, MCP, CI and non-interactive commands do not wait or print', async () => {
  const cases = [
    { options: { json: true } }, { options: { outputText: true } }, { options: { quiet: true } },
    { commandPath: 'channel currentBundle', options: { quiet: true } },
    { commandPath: 'bundle zip', options: { json: true } },
    { commandPath: 'init' }, { commandPath: 'build init' }, { commandPath: 'build onboarding' },
    { commandPath: 'mcp' }, { commandPath: 'account id' }, { commandPath: 'bundle releaseType' },
    { commandPath: 'build credentials export' }, { commandPath: 'generate-docs' },
    { commandPath: 'unknown-command' }, { ci: true }, { stdinTty: false }, { stdoutTty: false },
  ]
  const results = await Promise.all(cases.map(settings => run(settings).completion))
  for (const result of results) {
    assert.ok(waitedMs(result) < 100)
    assert.ok(!result.text.includes('Waiting for background checks'))
    assert.deepEqual(waitEvents(result), [])
  }
}, 12_000)

test.concurrent('telemetry opt-out and delivery errors preserve the wait and early exit', async () => {
  for (const settings of [{ disabled: true }, { telemetry: 'reject' }]) {
    const result = await run({ workers: ['quick.mjs'], ...settings }).completion
    assert.ok(waitedMs(result) < 2_000)
    assert.ok(result.text.includes('Waiting for background checks'))
    assert.equal(waitEvents(result).length, settings.disabled ? 0 : 1)
  }
})

test.concurrent('hanging telemetry is aborted within the same five-second budget', async () => {
  const result = await run({ workers: ['quick.mjs'], telemetry: 'hang' }).completion
  const duration = waitedMs(result)
  assert.ok(duration >= 4_900 && duration < 6_000, `telemetry wait was ${duration}ms`)
  assert.equal(waitEvents(result).length, 1)
  assert.ok(result.output.includes('telemetry-aborted'))
}, 12_000)
