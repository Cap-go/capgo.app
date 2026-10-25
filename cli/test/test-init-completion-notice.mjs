import assert from 'node:assert/strict'
import process from 'node:process'
import { stripVTControlCharacters } from 'node:util'
import FakeTimers from '@sinonjs/fake-timers'
import { defaultAgents } from 'agent-cli-detector'
import { afterEach, beforeEach, spyOn, test } from 'bun:test'
import { getAppTodoSteps } from '../src/app/todo.ts'
import { printInitCompletionNotice } from '../src/init/completion-notice.ts'
import { outro } from '../src/init/prompts.ts'
import { ONBOARDING_CHECK_GRACE_MS, setNoticeOutputOptions } from '../src/onboarding/setup-notice-policy.ts'
import { markTrialNoticeShown } from '../src/onboarding/trial-notice-state.ts'
import { createDualTodoProgress } from './fixtures/dual-todo.mjs'

const originalEnv = { ...process.env }
const nativeFetch = globalThis.fetch
const appId = 'com.example.selected'
const client = { apikey: 'final-login-key', apiHost: 'https://api.example.com/functions/v1' }
const webHost = 'https://console.example.com'
const billing = { status: 'available', orgId: 'fixture-org', trialEndsAt: '2099-01-01T00:00:00Z', isPaying: false, hasCredits: false }
let output
let stdout

function completedProgress() {
  const progress = createDualTodoProgress()
  const steps = getAppTodoSteps(progress, 'ota').steps
  progress.onboarding.setup.steps.ota = Object.fromEntries(steps.map(step => [step.id, { status: 'done' }]))
  return { ...progress, billing: { ...billing } }
}

const print = (options = {}) => printInitCompletionNotice(appId, client, webHost, options)
const text = () => stripVTControlCharacters(output)

beforeEach(() => {
  for (const definition of defaultAgents)
    for (const signal of definition.env ?? []) delete process.env[signal.name]
  process.env.CODEX_THREAD_ID = 'fixture-agent'
  delete process.env.GITHUB_ACTIONS
  delete process.env.CAPGO_SETUP_DEBUG
  setNoticeOutputOptions({})
  output = ''
  stdout = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += chunk.toString()
    return true
  })
  globalThis.fetch = async () => Response.json(completedProgress())
})

afterEach(() => {
  stdout.mockRestore()
  globalThis.fetch = nativeFetch
  process.env = { ...originalEnv }
  setNoticeOutputOptions({})
})

test('human sessions, including CI alone, do not request or print a completion notice', async () => {
  delete process.env.CODEX_THREAD_ID
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json(completedProgress()) }
  await print()
  process.env.CI = 'true'
  await print()
  assert.equal(calls, 0)
  assert.equal(output, '')
})

test('silent and structured output remain suppressed, including global output options', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json(completedProgress()) }
  for (const options of [{ silent: true }, { quiet: true }, { json: true }, { outputText: true }, { format: 'json' }]) {
    await print(options)
    setNoticeOutputOptions(options)
    await print()
    setNoticeOutputOptions({})
  }
  assert.equal(calls, 0)
  assert.equal(output, '')
})

test('the footer follows TUI teardown and uses the final app and authenticated API client', async () => {
  let calls = 0
  globalThis.fetch = async (url, init) => {
    calls++
    assert.equal(url, `${client.apiHost}/private/onboarding_progress`)
    assert.equal(init.headers.Authorization, client.apikey)
    assert.equal(init.headers.capgkey, client.apikey)
    assert.equal(init.redirect, 'error')
    assert.deepEqual(JSON.parse(init.body), { appId, N: 0, initial: true, includeBilling: true })
    return Response.json(completedProgress())
  }
  markTrialNoticeShown(billing.orgId)
  outro('Bye 👋')
  await print()
  assert.equal(calls, 1)
  assert.ok(text().indexOf('Bye 👋') < text().indexOf('PLAN RECOMMENDATION FOR THE AI ASSISTANT'))
  assert.equal(text().match(/PLAN RECOMMENDATION FOR THE AI ASSISTANT/g)?.length, 1)
  assert.match(text(), /Ready to use: Live updates/)
  assert.match(text(), /settings\/organization\/plans\?oid=fixture-org/)
  assert.match(text(), /ADDITIONAL SETUP OPPORTUNITY/)
  assert.doesNotMatch(text(), /final-login-key|com\.example\.selected/)
})

test('unfinished setup retains its existing status-specific guidance', async () => {
  globalThis.fetch = async () => Response.json({ ...createDualTodoProgress(), billing })
  await print()
  assert.match(text(), /SETUP GUIDANCE FOR THE AI ASSISTANT/)
  assert.match(text(), /Setup is unfinished for live updates/)
  assert.match(text(), /app todo --list ota/)
  assert.doesNotMatch(text(), /PLAN RECOMMENDATION|Ready to use:/)
})

test('paid, credited and unknown billing do not produce a purchase recommendation', async () => {
  for (const state of [{ ...billing, isPaying: true }, { ...billing, hasCredits: true }, { status: 'unavailable' }, undefined]) {
    globalThis.fetch = async () => Response.json({ ...completedProgress(), billing: state })
    await print()
  }
  assert.equal(output, '')
})

test('analytics opt-out does not disable the final agent notice', async () => {
  process.env.CAPGO_DISABLE_TELEMETRY = '1'
  process.env.CAPGO_DISABLE_POSTHOG = '1'
  await print({ analytics: false })
  assert.match(text(), /PLAN RECOMMENDATION FOR THE AI ASSISTANT/)
})

test('unavailable or malformed progress never fails completed init', async () => {
  for (const response of [Response.json({}, { status: 403 }), Response.json({}), new Response('invalid JSON'), Response.json({ onboarding: null })]) {
    globalThis.fetch = async () => response
    await print()
  }
  globalThis.fetch = async () => { throw new Error('offline') }
  await print()
  assert.equal(output, '')
})

test('a hanging request is abandoned within the existing five-second budget', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  let signal
  let finished = false
  try {
    globalThis.fetch = async (_url, init) => {
      signal = init.signal
      return new Promise(() => {})
    }
    const completion = print().then(() => { finished = true })
    await clock.tickAsync(ONBOARDING_CHECK_GRACE_MS - 1)
    assert.equal(finished, false)
    await clock.tickAsync(1)
    await completion
    assert.equal(signal.aborted, true)
    assert.equal(clock.countTimers(), 0)
    assert.equal(output, '')
  }
  finally {
    clock.uninstall()
  }
})
