#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatAppTodoList, getAppTodoSteps, readAppTodoProgress, TODO_BACKGROUND_WAIT_MS, waitForTodoBackgroundChecks } from '../src/app/todo.ts'
import { getAppOnboardingStepIds, parseAppOnboarding } from '../../supabase/functions/_backend/utils/appOnboarding.ts'
import messages from '../../messages/en.json'

const appId = 'com.example.todo'
const options = { apikey: 'test-todo-key', supaHost: 'http://localhost:54321', supaAnon: 'test-anon-key' }
const progress = {
  onboarding: {
    setup: {
      todo_list_version: 3,
      steps: {
        login_cli_mcp: { status: 'done' },
        add_channel: { status: 'done' },
        add_updater: { status: 'skipped' },
        add_code: { status: 'invalid' },
        completion: { status: 'done' },
      },
    },
  },
  hasChannel: false,
  checkErrors: [],
}

assert.equal(TODO_BACKGROUND_WAIT_MS, 10_000)
const countdown = []
const timedOutAt = Date.now()
assert.equal(await waitForTodoBackgroundChecks([new Promise(() => {})], seconds => countdown.push(seconds), 2_200), false)
assert.equal(countdown[0], 3)
assert.ok(countdown.length >= 2, 'interactive countdown updates while waiting')
assert.ok(countdown.slice(1).every((seconds, index) => seconds < countdown[index]), 'remaining seconds only decrease')
assert.ok(Date.now() - timedOutAt >= 2_100, 'wait honors its shared deadline')
let finishCheck
const completedCheck = new Promise(resolve => { finishCheck = resolve })
const finishEarly = waitForTodoBackgroundChecks([completedCheck], undefined, 10_000)
finishCheck()
assert.equal(await finishEarly, true, 'completed checks end the wait before the deadline')

for (const version of [1, 2, 3, 4, 0, -1, 1.5, '3', undefined]) {
  const value = { setup: { todo_list_version: version, steps: progress.onboarding.setup.steps } }
  const parsed = parseAppOnboarding(value)
  const actual = getAppTodoSteps({ onboarding: value })
  assert.equal(actual.version, parsed.todo_list_version)
  assert.deepEqual(actual.steps.map(step => step.id), getAppOnboardingStepIds(parsed.todo_list_version), 'step order matches the frontend')
  for (const step of actual.steps) {
    assert.equal(step.status, parsed.steps[step.id]?.status ?? 'pending')
    const prefix = actual.version === 3 ? 'setup-checklist-step-' : 'app-onboarding-cli-step-'
    assert.equal(step.title, messages[prefix + step.id], 'task titles match the frontend')
  }
}

for (const value of [null, [], {}, { setup: null }, { setup: [] }])
  assert.equal(getAppTodoSteps({ onboarding: value }).steps.length, 12)
assert.equal(getAppTodoSteps({ onboarding: { todo_list_version: 1, steps: { add_app: { status: 'done' } } } }).steps[0].status, 'done', 'supports legacy unwrapped setup')

const output = formatAppTodoList(appId, progress)
assert.match(output, /Todo list v3/)
assert.match(output, /2\/7 completed \(1 done, 1 skipped, 5 pending\)/)
assert.match(output, /\[x\] Done: Start guided setup/)
assert.match(output, /\[-\] Skipped: Install Capgo Updater/)
assert.match(output, /\[ \] Pending: Create a channel/)
assert.match(output, /\[ \] Pending: Add the app-ready code/)
assert.match(output, /Next step: Create a channel/)
assert.match(output, /Done when: Capgo finds a channel for this app/)
assert.match(output, /Run this command again to recheck progress/)
assert.doesNotMatch(output, /Done when: The CLI finds that call/, 'only the next pending step is explained')
assert.doesNotMatch(output, /\u001B\[/, 'plain output has no color codes')
const coloredOutput = formatAppTodoList(appId, progress, { color: true })
assert.match(coloredOutput, /\u001B\[32m\[x\] Done\u001B\[0m/)
assert.match(coloredOutput, /\u001B\[33m\[ \] Pending\u001B\[0m/)
assert.match(coloredOutput, /\u001B\[2m\[-\] Skipped\u001B\[0m/)
assert.match(coloredOutput, /\u001B\[1;36mNext step: Create a channel\u001B\[0m/)
assert.doesNotMatch(output, /Completion|encryption|undefined/)
assert.match(formatAppTodoList(appId, { ...progress, hasChannel: true }), /3\/7 completed/)
assert.match(formatAppTodoList(appId, { ...progress, hasChannel: true }), /Next step: Add the app-ready code/)
assert.match(formatAppTodoList(appId, { onboarding: progress.onboarding }), /3\/7 completed/, 'retains saved channel progress when the live check is unavailable')
assert.equal(progress.onboarding.setup.steps.add_channel.status, 'done', 'does not mutate saved progress')
const allDone = formatAppTodoList(appId, { onboarding: { setup: { todo_list_version: 3, steps: Object.fromEntries(getAppOnboardingStepIds(3).map(id => [id, { status: 'done' }])) } } })
assert.match(allDone, /7\/7 completed \(7 done, 0 skipped, 0 pending\)/)
assert.doesNotMatch(allDone, /Next step:/)
const v2Output = formatAppTodoList(appId, { onboarding: { setup: { todo_list_version: 2, steps: {} } } })
assert.doesNotMatch(v2Output, /Next step:|Done when:/, 'v2 keeps the checklist without v3 guidance')

for (const [id, action, completion] of [
  ['login_cli_mcp', 'Run a Capgo CLI command', 'Capgo records that CLI or MCP activity'],
  ['add_channel', 'Create a channel', 'Capgo finds a channel'],
  ['add_updater', 'Install @capgo/capacitor-updater', 'The CLI finds the dependency'],
  ['add_code', 'Call CapacitorUpdater.notifyAppReady()', 'The CLI finds that call'],
  ['run_device', 'Build and open the app', 'Capgo sees a device'],
  ['upload_bundle', 'Build and upload your first', 'Capgo finds a published bundle'],
  ['test_update', 'Assign the update', 'Capgo records a device applying'],
]) {
  const steps = Object.fromEntries(getAppOnboardingStepIds(3).map(stepId => [stepId, { status: stepId === id ? 'pending' : 'done' }]))
  const text = formatAppTodoList(appId, { onboarding: { setup: { todo_list_version: 3, steps } } })
  assert.match(text, new RegExp(`Next step: ${messages[`setup-checklist-step-${id}`]}`))
  assert.ok(text.includes(action), `${id} explains the action`)
  assert.ok(text.includes(`Done when: ${completion}`), `${id} explains the completion signal`)
  assert.equal((text.match(/Next step:/g) ?? []).length, 1)
}

const originalFetch = globalThis.fetch
try {
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), options.supaHost + '/functions/v1/private/onboarding_progress')
    assert.equal(init.method, 'POST')
    assert.deepEqual(JSON.parse(init.body), { appId, N: 0, initial: true })
    assert.equal(init.headers.capgkey, options.apikey)
    assert.equal(init.headers.Authorization, 'Bearer ' + options.supaAnon)
    return Response.json(progress)
  }
  assert.deepEqual(await readAppTodoProgress(appId, options), progress)
  for (const [status, expected] of [[401, /app.read permission/], [403, /app.read permission/], [404, /App not found/], [500, /database_unavailable/]]) {
    globalThis.fetch = async () => Response.json({ error: 'database_unavailable' }, { status })
    await assert.rejects(() => readAppTodoProgress(appId, options), expected)
  }
  globalThis.fetch = async () => Response.json({ status: 'ok' })
  await assert.rejects(() => readAppTodoProgress(appId, options), /invalid progress response/)
}
finally {
  globalThis.fetch = originalFetch
}

const fixture = mkdtempSync(join(tmpdir(), 'capgo-app-todo-'))
try {
  writeFileSync(join(fixture, 'capacitor.config.json'), JSON.stringify({ appId, appName: 'Todo test', webDir: 'dist' }))
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'todo-test', version: '1.0.0' }))
  const preload = join(fixture, 'fetch.mjs')
  writeFileSync(preload, `
    import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
    import { isMainThread } from 'node:worker_threads'
    const nativeFetch = globalThis.fetch
    const codeMarker = ${JSON.stringify(join(fixture, 'background-code-updated'))}
    const updaterMarker = ${JSON.stringify(join(fixture, 'background-updater-updated'))}
    const progressReads = ${JSON.stringify(join(fixture, 'progress-reads'))}
    globalThis.fetch = async (input, init) => {
      const url = input?.url ?? String(input)
      const scenario = process.env.CAPGO_TODO_SCENARIO
      if (!url.startsWith('http') || url.includes('.wasm')) return nativeFetch(input, init)
      if (url.includes('/private/config')) return Response.json({ supaHost: ${JSON.stringify(options.supaHost)}, supaKey: ${JSON.stringify(options.supaAnon)} })
      if (url.includes('/rpc/reject_access_due_to_2fa_for_app')) return Response.json(scenario === 'two-factor')
      if (scenario === 'background-updated' && init?.method === 'PUT' && url.endsWith('/app/${appId}')) {
        await new Promise(resolve => setTimeout(resolve, 700))
        const steps = JSON.parse(init.body).onboarding.steps
        if (steps.add_code) writeFileSync(codeMarker, 'done')
        if (steps.add_updater) writeFileSync(updaterMarker, 'done')
        return Response.json({ status: 'ok' })
      }
      if (url.includes('/private/onboarding_progress')) {
        if (scenario === 'background-updated' && isMainThread) appendFileSync(progressReads, 'read\\n')
        if (scenario === 'denied') return Response.json({ error: 'app_access_denied' }, { status: 403 })
        if (scenario === 'missing') return Response.json({ error: 'app_not_found' }, { status: 404 })
        if (scenario === 'failed') return Response.json({ error: 'database_unavailable' }, { status: 500 })
        if (scenario === 'invalid') return Response.json({ status: 'ok' })
        const progress = ${JSON.stringify(progress)}
        if (scenario === 'partial') progress.checkErrors = ['run_device']
        if (scenario === 'v2') progress.onboarding.setup.todo_list_version = 2
        if (scenario === 'empty') progress.onboarding = null
        if (scenario === 'background-updated') {
          progress.onboarding.setup.steps.add_code.status = existsSync(codeMarker) ? 'done' : 'pending'
          progress.onboarding.setup.steps.add_updater.status = existsSync(updaterMarker) ? 'done' : 'pending'
        }
        return Response.json(progress)
      }
      return Response.json({ status: 'ok' })
    }
  `)
  const builtCli = new URL('../dist/index.js', import.meta.url).pathname
  for (const alias of ['todo', 'todoList']) {
    const help = spawnSync('node', [builtCli, 'app', alias, '--help'], { encoding: 'utf8' })
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stdout, /todo\|todoList \[options\] \[appId\]/)
    for (const scenario of ['v3', 'v2', 'empty', 'partial', 'inferred', 'denied', 'missing', 'failed', 'invalid', 'two-factor']) {
      const child = spawnSync('node', [
        '--import', preload, builtCli, 'app', alias,
        ...(scenario === 'inferred' ? [] : [appId]),
        '-a', options.apikey, '--supa-host', options.supaHost, '--supa-anon', options.supaAnon,
      ], {
        cwd: fixture, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, CAPGO_TODO_SCENARIO: scenario, CAPGO_DISABLE_TELEMETRY: '1', CAPGO_DISABLE_POSTHOG: '1', CI: '1' },
      })
      const text = child.stdout + child.stderr
      const failure = ['denied', 'missing', 'failed', 'invalid', 'two-factor'].includes(scenario)
      assert.equal(child.status, failure ? 1 : 0, text)
      assert.match(text, /Loading the todo list/, 'non-interactive commands report the pending work')
      assert.doesNotMatch(text, /Todo list loaded|Could not load todo list/, 'non-interactive commands do not render spinner completion')
      assert.doesNotMatch(text, /\u001B\[/, 'non-interactive commands do not use ANSI colors')
      if (!failure) {
        assert.match(text, new RegExp('App: ' + appId.replaceAll('.', '\\.')))
        assert.match(text, /\[ \] Pending:/)
        if (scenario === 'v2') {
          assert.match(text, /Todo list v2/)
          assert.doesNotMatch(text, /Next step:/)
          assert.doesNotMatch(text, /Waiting 10 seconds for background TODO list checks/, 'v2 does not wait for background checks')
        }
        else if (scenario === 'empty') {
          assert.match(text, /0\/12 completed/)
          assert.doesNotMatch(text, /Waiting 10 seconds for background TODO list checks/)
        }
        else assert.match(text, /2\/7 completed/)
        if (scenario === 'partial') assert.match(text, /Some live progress checks failed/)
      }
      else {
        assert.doesNotMatch(text, /\[x\] Done:|\[ \] Pending:/, 'failures never print a misleading checklist')
        if (scenario === 'denied') assert.match(text, /app.read permission/)
        if (scenario === 'two-factor') assert.match(text, /2FA|two.factor/i)
      }
    }
  }
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({
    name: 'todo-test', version: '1.0.0', dependencies: { '@capgo/capacitor-updater': '8.0.0' },
  }))
  mkdirSync(join(fixture, 'node_modules/@capgo/capacitor-updater'), { recursive: true })
  writeFileSync(join(fixture, 'node_modules/@capgo/capacitor-updater/package.json'), JSON.stringify({ name: '@capgo/capacitor-updater', version: '8.0.0' }))
  mkdirSync(join(fixture, 'src'))
  writeFileSync(join(fixture, 'src/main.ts'), "import { CapacitorUpdater } from '@capgo/capacitor-updater'; CapacitorUpdater.notifyAppReady()")
  const backgroundUpdate = spawnSync('node', [
    '--import', preload, builtCli, 'app', 'todo', appId,
    '-a', options.apikey, '--supa-host', options.supaHost, '--supa-anon', options.supaAnon,
  ], {
    cwd: fixture, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, CAPGO_TODO_SCENARIO: 'background-updated', CAPGO_DISABLE_TELEMETRY: '1', CAPGO_DISABLE_POSTHOG: '1', CI: '1' },
  })
  const backgroundText = backgroundUpdate.stdout + backgroundUpdate.stderr
  assert.equal(backgroundUpdate.status, 0, backgroundText)
  assert.equal((backgroundText.match(/Waiting 10 seconds for background TODO list checks to finish/g) ?? []).length, 1, backgroundText)
  assert.doesNotMatch(backgroundText, /Waiting [1-9] seconds for background TODO list checks to finish/, 'non-interactive output does not count down')
  assert.match(backgroundText, /\[x\] Done: Add the app-ready code/, 'the printed list includes the background report')
  assert.match(backgroundText, /\[x\] Done: Install Capgo Updater/, 'the list waits for the updater check too')
  assert.equal(readFileSync(join(fixture, 'progress-reads'), 'utf8').trim().split('\n').length, 2, 'v3 rereads progress after the worker completes')
}
finally {
  rmSync(fixture, { recursive: true, force: true })
}
console.log('App todo frontend parity, live progress, errors, app ID inference, and both built CLI aliases passed')
