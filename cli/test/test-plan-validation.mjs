#!/usr/bin/env node
process.env.CAPGO_DISABLE_POSTHOG = '1'

import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { defaultAgents } from 'agent-cli-detector'
import { setNoticeOutputOptions } from '../src/onboarding/setup-notice-policy.ts'
import { wasTrialNoticeShown } from '../src/onboarding/trial-notice-state.ts'
import { checkPlanValid, checkPlanValidUpload, printAgentUploadTrialNote, runCliPreflight } from '../src/api/preflight.ts'
import * as utils from '../src/utils.ts'

console.log('🧪 Testing plan validation through the backend preflight...\n')

const agentEnvNames = [...new Set(defaultAgents.flatMap(agent => agent.env?.map(signal => signal.name) ?? []))]
const originalAgentEnv = Object.fromEntries(agentEnvNames.map(name => [name, process.env[name]]))
for (const name of agentEnvNames) delete process.env[name]

const apiHost = 'http://localhost:54321/functions/v1'

function makeClient() {
  return { apikey: 'test-plan-key', apiHost, filesHost: apiHost }
}

const originalFetch = globalThis.fetch
const httpCalls = []
const okBody = { user_id: 'u1', org_id: 'org-id', app_id: 'com.example.app', trial_days_left: null, warnings: [] }
let fetchHandler = () => Response.json(okBody)

globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url.endsWith('/private/config')) return Response.json({})
  if (!url.includes('/private/cli/preflight'))
    return originalFetch(input)
  httpCalls.push({
    url,
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(init.body) : undefined,
  })
  return fetchHandler(url, init)
}

let testsPassed = 0
let testsFailed = 0

async function test(name, fn) {
  try {
    console.log(`\n🔍 ${name}`)
    httpCalls.length = 0
    fetchHandler = () => Response.json(okBody)
    await fn()
    console.log(`✅ PASSED: ${name}`)
    testsPassed++
  }
  catch (error) {
    console.error(`❌ FAILED: ${name}`)
    console.error(`   Error: ${error.message}`)
    testsFailed++
  }
}

function assert(condition, message) {
  if (!condition)
    throw new Error(message)
}

function assertEquals(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

async function rejection(fn) {
  try {
    await fn()
  }
  catch (error) {
    return error
  }
  throw new Error('Expected a rejection')
}

await test('checkPlanValid asks the backend for the full metered plan in one call', async () => {
  await checkPlanValid(makeClient(), 'org-id', 'com.example.app', false)
  assertEquals(httpCalls.length, 1)
  assertEquals(httpCalls[0].url, `${apiHost}/private/cli/preflight`)
  assertEquals(httpCalls[0].body, { app_id: 'com.example.app', org_id: 'org-id', check_2fa: false, plan: 'all' })
})

await test('checkPlanValidUpload only gates storage', async () => {
  await checkPlanValidUpload(makeClient(), 'org-id', 'com.example.app', false)
  assertEquals(httpCalls[0].body, { app_id: 'com.example.app', org_id: 'org-id', check_2fa: false, plan: 'upload' })
})

await test('GitHub Actions publishes the existing preflight trial warning to both surfaces', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capgo-plan-notice-'))
  const previous = { github: process.env.GITHUB_ACTIONS, summary: process.env.GITHUB_STEP_SUMMARY }
  const write = process.stdout.write
  const writeSync = fs.writeSync
  let output = ''
  try {
    process.env.GITHUB_ACTIONS = 'true'
    process.env.GITHUB_STEP_SUMMARY = join(dir, 'summary.md')
    process.stdout.write = chunk => { output += chunk; return true }
    fs.writeSync = (fd, buffer, offset, length) => {
      if (fd !== 1) return writeSync(fd, buffer, offset, length)
      output += buffer.subarray(offset, offset + length).toString()
      return length
    }
    fetchHandler = () => Response.json({ ...okBody, trial_days_left: 3 })
    await checkPlanValidUpload(makeClient(), 'org-id', 'com.example.app')
    assert(output.includes('::notice::WARNING !!%0ATrial expires in 3 days, upgrade here:'), output)
    const summary = readFileSync(process.env.GITHUB_STEP_SUMMARY, 'utf8')
    assert(summary.includes('### WARNING'), summary)
    assert(summary.includes('Trial expires in 3 days, upgrade here:'), summary)
    assert(summary.includes('/settings/organization/plans?oid=org-id'), summary)
    assert(!summary.includes('trial_card'), 'human trial reminders keep the plain plans link')
    assert(wasTrialNoticeShown('org-id'), 'preflight prevents a duplicate background plan prompt')
  }
  finally {
    process.stdout.write = write
    fs.writeSync = writeSync
    if (previous.github === undefined) delete process.env.GITHUB_ACTIONS
    else process.env.GITHUB_ACTIONS = previous.github
    if (previous.summary === undefined) delete process.env.GITHUB_STEP_SUMMARY
    else process.env.GITHUB_STEP_SUMMARY = previous.summary
    rmSync(dir, { recursive: true, force: true })
  }
})

await test('preflight trial reminders honor every machine-output guard in GitHub Actions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capgo-machine-plan-notice-'))
  const previous = { github: process.env.GITHUB_ACTIONS, summary: process.env.GITHUB_STEP_SUMMARY }
  const summaryPath = join(dir, 'summary.md')
  writeFileSync(summaryPath, 'Existing summary\n')
  const write = process.stdout.write
  const writeSync = fs.writeSync
  let output = ''
  try {
    process.env.GITHUB_ACTIONS = 'true'
    process.env.GITHUB_STEP_SUMMARY = summaryPath
    process.stdout.write = chunk => { output += chunk; return true }
    fs.writeSync = (fd, buffer, offset, length) => {
      if (fd !== 1) return writeSync(fd, buffer, offset, length)
      output += buffer.subarray(offset, offset + length).toString()
      return length
    }
    fetchHandler = () => Response.json({ ...okBody, org_id: 'machine-output-org', trial_days_left: 3 })
    for (const github of ['false', 'true']) {
      process.env.GITHUB_ACTIONS = github
      for (const options of [{ json: true }, { quiet: true }, { silent: true }, { outputText: true }, { format: 'json' }]) {
        await runCliPreflight(makeClient(), { orgId: 'org-id', appId: 'com.example.app', plan: 'upload' }, options)
        setNoticeOutputOptions(options)
        await checkPlanValidUpload(makeClient(), 'org-id', 'com.example.app')
        setNoticeOutputOptions({})
      }
    }
    assertEquals(output, '', 'trial reminders cannot contaminate machine output')
    assertEquals(readFileSync(summaryPath, 'utf8'), 'Existing summary\n', 'machine modes cannot append to the job summary')
    assert(!wasTrialNoticeShown('machine-output-org'), 'suppressed output must not hide a later human-facing reminder')
    setNoticeOutputOptions({})
    await checkPlanValidUpload(makeClient(), 'org-id', 'com.example.app')
    assert(output.includes('Trial expires in 3 days'), 'the later human-mode reminder must print')
    assert(readFileSync(summaryPath, 'utf8').includes('Trial expires in 3 days'), 'the later human-mode summary must render')
    assert(wasTrialNoticeShown('machine-output-org'), 'a displayed reminder must mark its organization')
  }
  finally {
    process.stdout.write = write
    fs.writeSync = writeSync
    setNoticeOutputOptions({})
    if (previous.github === undefined) delete process.env.GITHUB_ACTIONS
    else process.env.GITHUB_ACTIONS = previous.github
    if (previous.summary === undefined) delete process.env.GITHUB_STEP_SUMMARY
    else process.env.GITHUB_STEP_SUMMARY = previous.summary
    rmSync(dir, { recursive: true, force: true })
  }
})

async function captureStdout(fn) {
  const write = process.stdout.write
  let output = ''
  try {
    process.stdout.write = chunk => { output += chunk; return true }
    await fn()
    return output
  }
  finally {
    process.stdout.write = write
  }
}

async function asAgent(fn) {
  const previous = { github: process.env.GITHUB_ACTIONS, claude: process.env.CLAUDECODE }
  try {
    process.env.GITHUB_ACTIONS = 'false'
    process.env.CLAUDECODE = '1'
    return await fn()
  }
  finally {
    if (previous.claude === undefined) delete process.env.CLAUDECODE
    else process.env.CLAUDECODE = previous.claude
    if (previous.github === undefined) delete process.env.GITHUB_ACTIONS
    else process.env.GITHUB_ACTIONS = previous.github
  }
}

await test('agents get no start-of-command trial box, and the end notice is not marked as shown', async () => {
  fetchHandler = () => Response.json({ ...okBody, org_id: 'agent-trial-org', trial_days_left: 3 })
  const output = await asAgent(() => captureStdout(() => checkPlanValidUpload(makeClient(), 'org-id', 'com.example.app')))
  assertEquals(output, '')
  assert(!wasTrialNoticeShown('agent-trial-org'), 'the end-of-command notice must still show the trial to agents')
})

await test('the post-upload trial note tells agents, not humans, to add a payment method before the trial ends', async () => {
  const result = { ...okBody, trialDaysLeft: 3 }
  const output = await asAgent(() => captureStdout(() => printAgentUploadTrialNote(result)))
  const date = new Date(Date.now() + 3 * 86_400_000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const link = output.match(/: (\S+)\n$/)?.[1]
  assertEquals(output, `\nAdd a payment method before ${date} to keep delivering updates like this one: the free trial ends then, and devices stop receiving live updates until a plan is active. No charge before ${date}: ${link}\n`)
  assert(link.endsWith('/settings/organization/plans?trial_card=1'), link)
  for (const value of [null, { ...result, trialDaysLeft: null }])
    assertEquals(await asAgent(() => captureStdout(() => printAgentUploadTrialNote(value))), '')
  assertEquals(await captureStdout(() => printAgentUploadTrialNote(result)), '', 'humans saw the trial warning before the upload')
})

await test('billing limit maps to plan upgrade copy', async () => {
  fetchHandler = () => Response.json({ error: 'plan_upgrade_required', message: 'Plan upgrade required' }, { status: 402 })
  const error = await rejection(() => checkPlanValidUpload(makeClient(), 'org-id', 'com.example.app', false))
  assertEquals(error.message, 'Plan upgrade required for upload')
})

await test('checkPlanValid reports permission denial instead of billing upgrade copy', async () => {
  fetchHandler = () => Response.json({ error: 'plan_permission_denied', message: 'denied' }, { status: 403 })
  const error = await rejection(() => checkPlanValid(makeClient(), 'org-id', 'com.example.app', false))
  assert(error.message.includes('Plan validation permission denied'), `Unexpected error: ${error.message}`)
  assert(!error.message.includes('Plan upgrade required'), 'Must not report a billing upgrade for RBAC denial')
})

await test('surfaces backend errors instead of reporting an invalid plan', async () => {
  fetchHandler = () => Response.json({ error: 'cannot_check_billing', message: 'Cannot check org plan actions' }, { status: 400 })
  const error = await rejection(() => checkPlanValid(makeClient(), 'org-id', 'com.example.app', false))
  assert(error.message.includes('Cannot check org plan actions'), `Unexpected error: ${error.message}`)
  assert(!error.message.includes('Plan upgrade required'), 'Backend failure must not look like an invalid plan')
})

await test('no CLI-side plan RPC helpers remain', () => {
  for (const name of ['isAllowedPlanActions', 'resolveMeteredPlanAllowed', 'isAllowedActionOrg', 'isPayingOrg', 'isTrialOrg'])
    assert(!(name in utils), `${name} must live in the backend`)
})

await test('canOpenExternalUrl is disabled in CI-like environments', () => {
  assertEquals(utils.canOpenExternalUrl({
    ci: true,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    display: ':0',
    platform: 'linux',
  }), false)
  assertEquals(utils.canOpenExternalUrl({
    ci: false,
    stdinIsTTY: false,
    stdoutIsTTY: true,
    display: ':0',
    platform: 'linux',
  }), false)
  assertEquals(utils.canOpenExternalUrl({
    ci: false,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    display: undefined,
    platform: 'linux',
  }), false)
  assertEquals(utils.canOpenExternalUrl({
    ci: false,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    display: ':0',
    platform: 'darwin',
  }), true)
})

globalThis.fetch = originalFetch
for (const [name, value] of Object.entries(originalAgentEnv)) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

console.log(`\n📊 Results: ${testsPassed} passed, ${testsFailed} failed`)
if (testsFailed > 0)
  process.exit(1)
