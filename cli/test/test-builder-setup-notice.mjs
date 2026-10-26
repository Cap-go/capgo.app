import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { stripVTControlCharacters } from 'node:util'
import { defaultAgents } from 'agent-cli-detector'
import { afterEach, beforeEach, mock, spyOn, test } from 'bun:test'
import { createDualTodoProgress } from './fixtures/dual-todo.mjs'

// The Builder wizard is an Ink app. Stub only `render` so every run behaves as
// if the user left the wizard, then the real command tail runs.
const realInk = { ...(await import('ink')) }
mock.module('ink', () => ({
  ...realInk,
  render: () => ({ rerender() {}, unmount() {}, waitUntilExit: async () => {} }),
}))
const { onboardingBuilderCommand } = await import('../src/build/onboarding/command.ts')
const { tryBuilderOnlyInit } = await import('../src/init/builder-setup.ts')
const { setNoticeOutputOptions } = await import('../src/onboarding/setup-notice-policy.ts')

const configAppId = 'com.example.builder.config'
const handoffAppId = 'com.example.builder.assigned'
const apikey = 'builder-notice-key'
const apiHost = 'https://api.example.com/functions/v1'
const billing = { status: 'available', orgId: 'fixture-org', trialEndsAt: '2099-01-01T00:00:00Z', isPaying: false, hasCredits: false }
const notice = /Capgo — next steps/g
const originalEnv = { ...process.env }
const originalCwd = process.cwd()
const originalTty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY }
let directory
let output
let requests
let stdout

const text = () => stripVTControlCharacters(output)
const noticeCount = () => text().match(notice)?.length ?? 0

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'capgo-builder-notice-'))
  writeFileSync(join(directory, 'capacitor.config.json'), JSON.stringify({ appId: configAppId, appName: 'Builder notice', webDir: 'dist' }))
  process.chdir(directory)
  for (const definition of defaultAgents)
    for (const signal of definition.env ?? []) delete process.env[signal.name]
  delete process.env.GITHUB_ACTIONS
  delete process.env.CAPGO_SETUP_DEBUG
  Object.assign(process.env, {
    CODEX_THREAD_ID: 'fixture-agent',
    HOME: directory,
    CAPGO_SKIP_UPDATE_PROMPT: '1',
    CAPGO_DISABLE_TELEMETRY: '1',
    CAPGO_DISABLE_POSTHOG: '1',
  })
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  setNoticeOutputOptions({})
  output = ''
  requests = []
  stdout = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += chunk.toString()
    return true
  })
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body), apikey: init.headers.capgkey })
    if (String(url) !== `${apiHost}/private/onboarding_progress`)
      throw new Error(`Unexpected request: ${url}`)
    return Response.json({ ...createDualTodoProgress(), billing })
  }
})

afterEach(() => {
  stdout.mockRestore()
  process.chdir(originalCwd)
  rmSync(directory, { recursive: true, force: true })
  process.env = { ...originalEnv }
  Object.defineProperty(process.stdin, 'isTTY', { value: originalTty.stdin, configurable: true })
  Object.defineProperty(process.stdout, 'isTTY', { value: originalTty.stdout, configurable: true })
  setNoticeOutputOptions({})
})

test('standalone build init prints the init setup notice once after the wizard exits', async () => {
  await onboardingBuilderCommand({ apikey, apiHost, analytics: false, enableSelfUpdate: true, enableProjectDiscovery: true })
  assert.deepEqual(requests, [{ url: `${apiHost}/private/onboarding_progress`, body: { appId: configAppId, N: 0, initial: true, includeBilling: true }, apikey }])
  assert.equal(noticeCount(), 1, text())
  assert.ok(text().indexOf('Capgo onboarding exited') < text().search(notice), 'the notice is the closing footer')
})

test('init handing off to the Builder wizard prints the notice exactly once for the assigned app', async () => {
  assert.equal(await tryBuilderOnlyInit(handoffAppId, { apikey, apiHost, analytics: false }, { knownBuilderOnly: true }), true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].body.appId, handoffAppId)
  assert.equal(noticeCount(), 1, text())
})

test('init output options still suppress the notice after the handoff', async () => {
  for (const options of [{ silent: true }, { json: true }])
    await tryBuilderOnlyInit(handoffAppId, { apikey, apiHost, analytics: false, ...options }, { knownBuilderOnly: true })
  delete process.env.CODEX_THREAD_ID
  await onboardingBuilderCommand({ apikey, apiHost, analytics: false, enableSelfUpdate: true })
  assert.deepEqual(requests, [])
  assert.equal(noticeCount(), 0)
})

test('wrapper commands that reach the wizard as a sub-step do not print it', async () => {
  // `bundle upload` and `build credentials manage` call the wizard this way.
  await onboardingBuilderCommand({ apikey })
  await onboardingBuilderCommand({})
  assert.deepEqual(requests, [])
  assert.equal(noticeCount(), 0)
})
