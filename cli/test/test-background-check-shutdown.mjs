import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import stringWidth from 'string-width'
import { afterAll, beforeAll, test } from 'bun:test'
import { defaultAgents } from 'agent-cli-detector'

const dir = mkdtempSync(join(tmpdir(), 'capgo-background-shutdown-'))
let harness
let runnerCount = 0

beforeAll(async () => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(join(dir, 'entry.ts'), `
    export { startOnboardingCheck } from ${JSON.stringify(fileURLToPath(new URL('../src/onboarding/background.ts', import.meta.url)))}
    export { waitForOnboardingChecks } from ${JSON.stringify(fileURLToPath(new URL('../src/onboarding/background-shutdown.ts', import.meta.url)))}
    export { getPendingOnboardingChecks } from ${JSON.stringify(fileURLToPath(new URL('../src/onboarding/background-workers.ts', import.meta.url)))}
    export { markTrialNoticeShown } from ${JSON.stringify(fileURLToPath(new URL('../src/onboarding/trial-notice-state.ts', import.meta.url)))}
  `)
  // The production build stubs this optional Ink development dependency.
  const build = await Bun.build({ entrypoints: [join(dir, 'entry.ts')], outdir: dir, target: 'node', format: 'esm', external: ['react-devtools-core'] })
  assert.equal(build.success, true)
  harness = pathToFileURL(join(dir, 'entry.js')).href
  writeFileSync(join(dir, 'busy.mjs'), 'setInterval(() => {}, 10_000)')
  writeFileSync(join(dir, 'quick.mjs'), 'setTimeout(() => {}, 300)')
  writeFileSync(join(dir, 'slow.mjs'), 'setTimeout(() => {}, 900)')
  writeFileSync(join(dir, 'released.mjs'), "import { parentPort } from 'node:worker_threads'; parentPort.once('message', () => process.exit(0))")
  writeFileSync(join(dir, 'notice.mjs'), `import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ type: 'setup-notice', notice: { kind: 'setup', appId: 'com.example.ready', product: 'live updates', title: 'Create a channel', action: 'Continue your checklist', secondary: [] } })`)
  for (const app of ['one', 'two', 'trial', 'agent']) {
    writeFileSync(join(dir, `plan-${app}.mjs`), `import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ type: 'setup-notice', notice: { kind: 'plan', appId: 'com.example.${app}', completed: ['Live updates'], secondary: ${JSON.stringify(app === 'agent' ? ['explore cloud builds'] : [])}, billing: { orgId: 'fixture-org', trialEndsAt: ${JSON.stringify(['trial', 'agent'].includes(app) ? '2099-01-01T00:00:00Z' : null)}, plansUrl: 'https://console.example.com/plans' } } })`)
  }
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function run({ commandPath = 'app list', options = {}, tty = true, stdinTty = tty, stdoutTty = tty, ci = false, github = false, summaryPath = '', noticeWriteFailure = false, noticeWriteChunkSize = 0, priorFlushMs = 0, workers = ['busy.mjs'], foregroundMs = 0, previousInterrupt = false, telemetry = 'ok', disabled = false, controlledClock = false, earlyCompletion = false, immediateCompletion = false, waitForWorkers = false, trialAlreadyShown = false, debug = false, columns = 80, colorEnv = {}, agent = false } = {}) {
  const source = `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import { performance } from 'node:perf_hooks'
    import FakeTimers from ${JSON.stringify(import.meta.resolve('@sinonjs/fake-timers'))}
    import { setImmediate as nextTurn } from 'node:timers/promises'
    import { startOnboardingCheck, waitForOnboardingChecks, getPendingOnboardingChecks, markTrialNoticeShown } from ${JSON.stringify(harness)}
    Object.defineProperty(process.stdin, 'isTTY', { value: ${stdinTty} })
    Object.defineProperty(process.stdout, 'isTTY', { value: ${stdoutTty} })
    Object.defineProperty(process.stdout, 'columns', { value: ${columns} })
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
      startOnboardingCheck(command, ${JSON.stringify(commandPath)}, new URL(filename, ${JSON.stringify(pathToFileURL(join(dir, 'run.mjs')).href)}), undefined, ${ci})
    if (${waitForWorkers}) {
      const checks = [...getPendingOnboardingChecks()]
      for (const [worker] of checks) worker.ref()
      await Promise.all(checks.map(([, check]) => check.completion))
    }
    let noticeWriteCalls = 0
    if (${noticeWriteFailure || noticeWriteChunkSize > 0}) {
      const write = fs.writeSync
      fs.writeSync = (fd, buffer, offset, length) => {
        if (fd !== 1) return write(fd, buffer, offset, length)
        noticeWriteCalls++
        if (${noticeWriteFailure}) throw new Error('synthetic notice write failure')
        return write(fd, buffer, offset, Math.min(length, ${noticeWriteChunkSize}))
      }
    }
    console.log('pending-attempts:' + JSON.stringify([...getPendingOnboardingChecks().values()].map(check => check.attemptId)))
    let foregroundInterrupts = 0
    if (${previousInterrupt}) {
      process.on('SIGINT', () => { foregroundInterrupts++; console.log('foreground-interrupted') })
      process.emit('SIGINT')
    }
    await new Promise(resolve => setTimeout(resolve, ${foregroundMs}))
    if (${trialAlreadyShown}) markTrialNoticeShown('fixture-org')
    console.log('interrupt-count-before-wait:' + foregroundInterrupts)
    const clock = ${controlledClock} ? FakeTimers.install({ now: Date.now(), toFake: ['setTimeout', 'clearTimeout', 'Date'] }) : undefined
    const now = ${controlledClock} ? Date.now : () => performance.now()
    const started = now()
    let finished = false
    const completion = waitForOnboardingChecks(command, ${JSON.stringify(commandPath)}, Date.now() - ${priorFlushMs}).then(() => { finished = true })
    if (${immediateCompletion}) {
      await completion
      assert.equal(finished, true, 'shutdown must finish without advancing the clock')
    }
    else if (${earlyCompletion}) {
      const checks = [...getPendingOnboardingChecks()]
      for (const [worker] of checks) worker.ref()
      checks[0][0].postMessage('finish')
      await checks[0][1].completion
      await nextTurn()
      assert.equal(finished, false, 'shutdown must wait for the last worker')
      for (const [worker] of checks.slice(1)) worker.postMessage('finish')
      await Promise.all(checks.map(([, check]) => check.completion))
      await nextTurn()
      clock.tick(0)
      await completion
      assert.equal(finished, true, 'shutdown must finish without advancing the deadline')
    }
    else if (${controlledClock}) {
      // Keep real workers and telemetry, but advance the shared deadline without
      // measuring how quickly a busy CI runner schedules this child process.
      if (${JSON.stringify(telemetry)} === 'hang') {
        // Mock timers cannot keep the process alive. Release real workers only
        // after shutdown starts, then prove telemetry alone waits for the deadline.
        const checks = [...getPendingOnboardingChecks()]
        for (const [worker] of checks) {
          worker.ref()
          worker.postMessage('finish')
        }
        await Promise.all(checks.map(([, check]) => check.completion))
      }
      await nextTurn()
      clock.tick(${4999 - priorFlushMs})
      await nextTurn()
      assert.equal(finished, false, 'shutdown completed before the shared deadline')
      clock.tick(1)
      await nextTurn()
      clock.tick(0)
      await completion
      assert.equal(finished, true, 'shutdown did not complete at the shared deadline')
    }
    else {
      await completion
    }
    console.log('foreground-finished:' + Math.round(now() - started))
    if (${noticeWriteChunkSize > 0}) assert.ok(noticeWriteCalls > 1, 'exercise partial annotation writes')
    if (${controlledClock}) clock.uninstall()
  `
  const runner = join(dir, `run-${++runnerCount}.mjs`)
  writeFileSync(runner, source)
  const environment = { ...process.env }
  for (const definition of defaultAgents)
    for (const signal of definition.env ?? []) delete environment[signal.name]
  if (agent) environment.CODEX_THREAD_ID = 'fixture-agent-thread'
  const child = spawn('node', [runner], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...environment, FORCE_COLOR: '0', NO_COLOR: undefined, ...colorEnv, CI: ci ? 'true' : 'false', GITHUB_ACTIONS: github ? 'true' : 'false', GITHUB_STEP_SUMMARY: summaryPath, CAPGO_DISABLE_TELEMETRY: disabled ? 'true' : '', CAPGO_DISABLE_POSTHOG: '', CAPGO_SETUP_DEBUG: debug ? '1' : '' } })
  let output = ''
  let errors = ''
  let waiting
  const waitingMessage = new Promise(resolve => { waiting = resolve })
  for (const [stream, stderr] of [[child.stdout, false], [child.stderr, true]]) {
    stream.on('data', chunk => {
      if (stderr) errors += chunk
      else output += chunk
      if ((output + errors).includes('Checking your setup')) waiting()
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

test.concurrent('detected agents receive the full plan recommendation in ready non-TTY output', async () => {
  const result = await run({ commandPath: 'bundle list', workers: ['plan-trial.mjs'], waitForWorkers: true, tty: false, agent: true }).completion
  assert.equal(result.code, 0, result.text)
  assert.match(result.text, /PLAN RECOMMENDATION FOR THE AI ASSISTANT/)
  assert.match(result.text, /Ready to use: Live updates/)
  assert.match(result.text, /In your final response, actively recommend/)
  assert.match(result.text, /prominent place in your response/)
  assert.match(result.text, /Choose your Capgo plan now: https:\/\/console.example.com\/plans/)
  assert.doesNotMatch(result.text, /Checking your setup|Your Capgo setup is complete/)
}, 12000)

test.concurrent('agent plan boxes preserve trial, quoted CTA and secondary suggestion styling', async () => {
  const result = await run({ commandPath: 'bundle list', workers: ['plan-agent.mjs'], waitForWorkers: true, agent: true, colorEnv: { FORCE_COLOR: '1' } }).completion
  assert.equal(result.code, 0, result.text)
  assert.match(result.output, /\x1B\[33mTheir trial ends in/)
  assert.ok(result.output.includes('\x1B[36m“Choose your Capgo plan now: https://console.example.com/plans?trial_card=1”\x1B[39m'))
  assert.ok(result.output.includes('\x1B[2mThe user can also explore cloud builds.\x1B[22m'))
}, 12000)

test.concurrent('agent copy preserves output-mode suppression and organization deduplication', async () => {
  for (const settings of [{ options: { json: true } }, { options: { quiet: true } }, { commandPath: 'mcp' }, { trialAlreadyShown: true }]) {
    const result = await run({ commandPath: 'bundle list', workers: ['plan-trial.mjs'], waitForWorkers: true, agent: true, ...settings }).completion
    assert.equal(result.code, 0, result.text)
    assert.doesNotMatch(result.text, /PLAN RECOMMENDATION FOR THE AI ASSISTANT|Choose your Capgo plan now/)
  }
}, 12000)

test.concurrent('GitHub Actions delivers agent plan messages in annotations and the job summary', async () => {
  const summaryPath = join(dir, 'agent-summary.md')
  const result = await run({ commandPath: 'bundle list', workers: ['plan-agent.mjs'], waitForWorkers: true, tty: false, ci: true, github: true, summaryPath, agent: true }).completion
  assert.equal(result.code, 0, result.text)
  assert.match(result.output, /::notice::CAPGO — PLAN RECOMMENDATION FOR THE AI ASSISTANT%0A/)
  for (const text of [result.output, readFileSync(summaryPath, 'utf8')]) {
    assert.match(text, /Ready to use: Live updates/)
    assert.match(text, /prominent place in your response/)
    assert.match(text, /Choose your Capgo plan now: https:\/\/console.example.com\/plans/)
    assert.match(text, /The user can also explore cloud builds/)
    assert.doesNotMatch(text, /\x1B\[|Checking your setup/)
  }
}, 12000)

test.concurrent('ready notices render for human-readable output even when no worker or TTY wait remains', async () => {
  for (const tty of [true, false]) {
    const result = await run({ commandPath: 'bundle list', workers: ['notice.mjs', 'notice.mjs'], waitForWorkers: true, tty }).completion
    assert.equal(result.code, 0, result.text)
    assert.equal(result.text.match(/Finish setting up live updates/g)?.length, 1, 'deduplicate the app notice')
    assert.match(result.text, /┌─+┐/, 'setup notice has a closed top box border')
    assert.match(result.text, /└─+┘/, 'setup notice has a closed bottom box border')
    assert.ok(!result.text.includes('Checking your setup'))
  }
}, 12_000)

test.concurrent('machine modes and explicit setup flows discard ready notices', async () => {
  const cases = [{ options: { json: true } }, { options: { outputText: true } }, { options: { quiet: true } }, { options: { silent: true } }, { options: { format: 'json' } }, { commandPath: 'app todo' }, { commandPath: 'build init' }, { commandPath: 'mcp' }]
  for (const settings of cases) {
    const result = await run({ commandPath: 'bundle list', workers: ['notice.mjs'], waitForWorkers: true, ...settings }).completion
    assert.equal(result.code, 0, result.text)
    assert.ok(!result.text.includes('Finish setting up live updates'))
  }
}, 12000)

test.concurrent('plan prompts are deduplicated by organization, including foreground trial warnings', async () => {
  for (const trialAlreadyShown of [false, true]) {
    const result = await run({ commandPath: 'bundle list', workers: ['plan-one.mjs', 'plan-two.mjs'], waitForWorkers: true, trialAlreadyShown }).completion
    assert.equal(result.code, 0, result.text)
    assert.equal((result.text.match(/Choose a Capgo plan/g) ?? []).length, trialAlreadyShown ? 0 : 1)
  }
}, 12_000)

function waitEvents(result) {
  return result.output.split('\n').filter(line => line.startsWith('telemetry:')).map(line => JSON.parse(line.slice('telemetry:'.length)))
}

test.concurrent('both workers share one five-second shutdown budget', async () => {
  const { completion } = run({ workers: ['busy.mjs', 'busy.mjs'], controlledClock: true })
  const result = await completion
  const duration = waitedMs(result)
  assert.equal(duration, 5_000, 'workers must share one five-second deadline')
  assert.equal(result.text.match(/Checking your setup/g)?.length, 1)
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

test.concurrent('channel promote gives its eligible setup notice the same bounded grace period', async () => {
  const result = await run({ commandPath: 'channel promote', controlledClock: true }).completion
  assert.equal(waitedMs(result), 5_000)
  assert.ok(result.text.includes('Checking your setup'))
}, 12_000)

test.concurrent('exits early as soon as the last worker finishes', async () => {
  const result = await run({ workers: ['released.mjs', 'released.mjs'], controlledClock: true, earlyCompletion: true }).completion
  assert.equal(waitedMs(result), 0, 'worker completion must release shutdown before the deadline')
  assert.ok(result.text.includes('Checking your setup'))
}, 12_000)

test.concurrent('completed or absent checks produce no waiting message or delay', async () => {
  for (const settings of [{ workers: [] }, { workers: ['quick.mjs'], waitForWorkers: true }]) {
    const result = await run({ ...settings, controlledClock: true, immediateCompletion: true }).completion
    assert.equal(waitedMs(result), 0)
    assert.ok(!result.text.includes('Checking your setup'))
    assert.deepEqual(waitEvents(result), [])
  }
}, 12_000)

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
}, 12_000)

test.concurrent('machine output, init, MCP and non-interactive commands do not wait or print', async () => {
  const cases = [
    { options: { json: true } }, { options: { outputText: true } }, { options: { quiet: true } }, { options: { silent: true } }, { options: { format: 'json' } },
    { commandPath: 'channel currentBundle', options: { quiet: true } },
    { commandPath: 'bundle zip', options: { json: true } },
    { commandPath: 'init' }, { commandPath: 'build init' }, { commandPath: 'build onboarding' },
    { commandPath: 'mcp' }, { commandPath: 'account id' }, { commandPath: 'bundle releaseType' },
    { commandPath: 'build credentials export' }, { commandPath: 'generate-docs' },
    { commandPath: 'unknown-command' }, { stdinTty: false }, { stdoutTty: false },
  ]
  const results = await Promise.all(cases.map(settings => run({ ...settings, controlledClock: true, immediateCompletion: true }).completion))
  for (const result of results) {
    assert.equal(waitedMs(result), 0)
    assert.ok(!result.text.includes('Checking your setup'))
    assert.deepEqual(waitEvents(result), [])
  }
}, 12_000)

test.concurrent('telemetry opt-out and delivery errors preserve the wait and early exit', async () => {
  for (const settings of [{ disabled: true }, { telemetry: 'reject' }]) {
    const result = await run({ workers: ['released.mjs', 'released.mjs'], controlledClock: true, earlyCompletion: true, ...settings }).completion
    assert.equal(waitedMs(result), 0)
    assert.ok(result.text.includes('Checking your setup'))
    assert.equal(waitEvents(result).length, settings.disabled ? 0 : 1)
  }
}, 12_000)

test.concurrent('hanging telemetry is aborted within the same five-second budget', async () => {
  const result = await run({ workers: ['released.mjs'], telemetry: 'hang', controlledClock: true }).completion
  const duration = waitedMs(result)
  assert.equal(duration, 5_000, 'telemetry must share the worker deadline')
  assert.equal(waitEvents(result).length, 1)
  assert.ok(result.output.includes('telemetry-aborted'))
}, 12_000)


test.concurrent('opt-in diagnostics distinguish shutdown timeout from a non-TTY skip', async () => {
  const timed = await run({ commandPath: 'bundle list', debug: true, controlledClock: true }).completion
  assert.equal(timed.code, 0, timed.text)
  assert.match(timed.errors, /\[setup-debug /)
  assert.match(timed.errors, /shutdown deadline reached/)
  assert.match(timed.errors, /pending_workers=1/)
  const piped = await run({ commandPath: 'bundle list', debug: true, tty: false }).completion
  assert.equal(piped.code, 0, piped.text)
  assert.match(piped.errors, /shutdown wait skipped/)
  assert.match(piped.errors, /stdout_tty=false/)
  assert.doesNotMatch(piped.output, /\[setup-debug /, 'diagnostics must not pollute stdout')
  const normal = await run({ commandPath: 'bundle list', tty: false }).completion
  assert.doesNotMatch(normal.text, /\[setup-debug /, 'logging is off by default')
}, 12_000)


test.concurrent('standalone boxes have no guide line, diamond or app ID and fit a narrow terminal', async () => {
  const result = await run({ commandPath: 'bundle list', workers: ['notice.mjs'], waitForWorkers: true, columns: 52, colorEnv: { FORCE_COLOR: '1' } }).completion
  assert.equal(result.code, 0, result.text)
  const lines = stripVTControlCharacters(result.output).split('\n')
  const start = lines.findIndex(line => line.startsWith('┌'))
  const end = lines.findIndex((line, index) => index > start && line.startsWith('└'))
  assert.ok(start >= 0 && end > start, result.text)
  const rendered = lines.slice(start, end + 1)
  assert.doesNotMatch(rendered.join('\n'), /[◇◆●├]|App:|com\.example/)
  for (const line of rendered) {
    assert.ok(stringWidth(line) <= 52, line)
    assert.equal(stringWidth(line), stringWidth(rendered[0]), line)
  }
}, 12_000)


test.concurrent('interactive setup and plan boxes highlight headings and primary actions', async () => {
  for (const [worker, heading, color, action] of [
    ['notice.mjs', 'Finish setting up live updates', 36, 'Continue your checklist'],
    ['plan-one.mjs', 'Your Capgo setup is complete', 32, 'View plans: https://console.example.com/plans'],
    ['plan-trial.mjs', 'Your Capgo setup is complete', 32, 'View plans: https://console.example.com/plans'],
  ]) {
    const result = await run({ commandPath: 'bundle list', workers: [worker], waitForWorkers: true, colorEnv: { FORCE_COLOR: '1' } }).completion
    assert.equal(result.code, 0, result.text)
    assert.ok(result.output.includes(`\x1B[${color}m${heading}\x1B[39m`), 'emphasize the heading')
    assert.ok(result.output.includes(`\x1B[36m${action}\x1B[39m`), 'highlight the primary action')
    if (worker === 'plan-trial.mjs') assert.match(result.output, /\x1B\[33mYour trial ends in/)
    assert.match(stripVTControlCharacters(result.output), /┌─+┐/)
  }
}, 12_000)

test.concurrent('notice colors respect NO_COLOR, disabled colors and piped output', async () => {
  for (const settings of [
    { colorEnv: { NO_COLOR: '1', FORCE_COLOR: '1' } },
    { colorEnv: { FORCE_COLOR: '0' } },
    { tty: false, colorEnv: { FORCE_COLOR: '1' } },
    { colorEnv: { TERM: 'dumb', FORCE_COLOR: undefined } },
  ]) {
    const result = await run({ commandPath: 'bundle list', workers: ['notice.mjs'], waitForWorkers: true, ...settings }).completion
    assert.equal(result.code, 0, result.text)
    assert.equal(result.output, stripVTControlCharacters(result.output), `keep plain output free of ANSI sequences: ${JSON.stringify(settings)}`)
    assert.ok(result.output.includes('Finish setting up live updates'))
  }
}, 12_000)


test.concurrent('CI waits for enabled background notices without an interactive banner', async () => {
  const worker = 'ci-notice.mjs'
  writeFileSync(join(dir, worker), `import { parentPort, workerData } from 'node:worker_threads'; setTimeout(() => { if (workerData.setupNotice) parentPort.postMessage({ type: 'setup-notice', notice: { kind: 'setup', appId: 'com.example.ci', product: 'live updates', title: 'Create a channel', action: 'Continue your checklist', secondary: [] } }) }, 150)`)
  for (const github of [false, true]) {
    const summaryPath = join(dir, `summary-${github}.md`)
    writeFileSync(summaryPath, 'Existing summary\n')
    const result = await run({ commandPath: 'bundle upload', ci: true, tty: false, github, summaryPath, workers: [worker] }).completion
    assert.equal(result.code, 0, result.text)
    assert.match(result.text, /Finish setting up live updates/)
    assert.doesNotMatch(result.text, /Checking your setup|Press Ctrl\+C/)
    if (github) {
      assert.equal((result.output.match(/^::notice::/gm) ?? []).length, 1)
      assert.match(result.output, /%0A/)
      const summary = readFileSync(summaryPath, 'utf8')
      assert.match(summary, /^Existing summary\n/)
      assert.match(summary, /### Finish setting up live updates/)
      assert.match(summary, /Continue your checklist/)
    }
    else assert.equal(readFileSync(summaryPath, 'utf8'), 'Existing summary\n')
  }
}, 12_000)

test.concurrent('CI background workers share the existing five-second ceiling', async () => {
  const result = await run({ ci: true, tty: false, controlledClock: true }).completion
  assert.equal(waitedMs(result), 5_000)
  assert.doesNotMatch(result.text, /Checking your setup|Press Ctrl\+C/)
}, 12_000)

test.concurrent('GitHub Actions preserves machine modes and ignores unavailable summaries', async () => {
  const machineSummary = join(dir, 'machine-output-summary.md')
  writeFileSync(machineSummary, 'Existing summary\n')
  for (const options of [{ json: true }, { outputText: true }, { quiet: true }, { silent: true }, { format: 'json' }]) {
    for (const settings of [{}, { workers: ['notice.mjs'], waitForWorkers: true }]) {
      const result = await run({ commandPath: 'bundle upload', ci: true, tty: false, github: true, summaryPath: machineSummary, options, controlledClock: true, immediateCompletion: true, ...settings }).completion
      assert.equal(waitedMs(result), 0)
      assert.doesNotMatch(result.text, /::notice::/)
      assert.equal(readFileSync(machineSummary, 'utf8'), 'Existing summary\n')
    }
  }
  for (const summaryPath of ['', join(dir, 'absent', 'summary.md')]) {
    const result = await run({ commandPath: 'bundle list', ci: true, tty: false, github: true, summaryPath, workers: ['notice.mjs'], waitForWorkers: true }).completion
    assert.equal(result.code, 0, result.text)
    assert.match(result.output, /^::notice::/m)
    assert.equal((result.text.match(/Finish setting up live updates/g) ?? []).length, 1, 'a summary failure must not duplicate an already printed notice')
  }
}, 12_000)


test.concurrent('GitHub notices escape workflow commands and Markdown from message text', async () => {
  const notice = { kind: 'setup', appId: 'com.example.escaped', product: 'live <script> *updates* <SCRIPT> <ScRiPt>', title: '50% ready\r\n::warning::injected', action: 'Continue your checklist', secondary: [] }
  writeFileSync(join(dir, 'escaped.mjs'), `import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ type: 'setup-notice', notice: ${JSON.stringify(notice)} })`)
  const summaryPath = join(dir, 'escaped-summary.md')
  const result = await run({ commandPath: 'bundle list', ci: true, tty: false, github: true, summaryPath, workers: ['escaped.mjs'], waitForWorkers: true }).completion
  assert.equal(result.code, 0, result.text)
  assert.match(result.output, /50%25 ready%0D%0A::warning::injected/)
  assert.doesNotMatch(result.output, /^::warning::/m)
  const summary = readFileSync(summaryPath, 'utf8')
  assert.ok(summary.includes('&lt;script&gt; \\*updates\\*'), summary)
  assert.ok(summary.includes('&lt;SCRIPT&gt; &lt;ScRiPt&gt;'), summary)
  assert.equal(summary.includes('<'), false, summary)
}, 12_000)

test.concurrent('GitHub plan notices retain organization-level trial deduplication', async () => {
  for (const trialAlreadyShown of [false, true]) {
    const result = await run({ commandPath: 'bundle upload', ci: true, tty: false, github: true, workers: ['plan-one.mjs', 'plan-two.mjs'], waitForWorkers: true, trialAlreadyShown }).completion
    assert.equal(result.code, 0, result.text)
    assert.equal((result.output.match(/^::notice::/gm) ?? []).length, trialAlreadyShown ? 0 : 1)
  }
}, 12_000)


test.concurrent('GitHub annotation write failure falls back to the existing setup message', async () => {
  const result = await run({ commandPath: 'bundle list', ci: true, tty: false, github: true, noticeWriteFailure: true, workers: ['notice.mjs'], waitForWorkers: true }).completion
  assert.equal(result.code, 0, result.text)
  assert.doesNotMatch(result.output, /^::notice::/m)
  assert.match(result.text, /Finish setting up live updates/)
  assert.match(result.text, /Continue your checklist/)
}, 12_000)


test.concurrent('pre-wait analytics draining shares the same five-second shutdown deadline', async () => {
  const result = await run({ ci: true, tty: false, priorFlushMs: 2_000, controlledClock: true }).completion
  assert.equal(waitedMs(result), 3_000, 'two seconds of analytics draining leave three seconds for checks')
}, 12_000)

test.concurrent('GitHub annotations finish partial writes before suppressing the terminal fallback', async () => {
  const result = await run({ commandPath: 'bundle list', ci: true, tty: false, github: true, noticeWriteChunkSize: 7, workers: ['notice.mjs'], waitForWorkers: true }).completion
  assert.equal(result.code, 0, result.text)
  assert.match(result.output, /^::notice::Finish setting up live updates.*Continue your checklist\n/m)
  assert.equal((result.text.match(/Finish setting up live updates/g) ?? []).length, 1)
}, 12_000)
