#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultAgents } from 'agent-cli-detector'
import { appId } from './fixtures/dual-todo.mjs'

const cwd = mkdtempSync(join(tmpdir(), 'capgo-dual-todo-'))
writeFileSync(join(cwd, 'capacitor.config.json'), JSON.stringify({ appId, appName: 'Todo test', webDir: 'dist' }))
writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'todo-test', version: '1.0.0' }))
const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const preload = fileURLToPath(new URL('./fixtures/todo-api-preload.mjs', import.meta.url))
const humanEnv = { ...process.env }
for (const definition of defaultAgents)
  for (const signal of definition.env ?? []) delete humanEnv[signal.name]
function run(args = [], scenario, alias = 'todo', env = {}) {
  const child = spawnSync('node', [
    '--import', preload, cli, 'app', alias, appId,
    '--apikey', 'example-todo-key', '--api-host', 'https://todo.fixture.invalid', ...args,
  ], {
    cwd, encoding: 'utf8', timeout: 15_000,
    env: { ...humanEnv, TZ: 'UTC', CI: '1', CAPGO_TODO_FIXTURE_SCENARIO: scenario, CAPGO_DISABLE_TELEMETRY: '1', CAPGO_DISABLE_POSTHOG: '1', ...env },
  })
  return { ...child, text: child.stdout + child.stderr }
}
try {
  const missing = run()
  assert.equal(missing.status, 1, missing.text)
  assert.match(missing.text, /--list builder.*--list ota/)
  assert.doesNotMatch(missing.text, /\[x\] Done|\[ \] Pending/, 'a missing selector never silently chooses one checklist')
  for (const alias of ['todo', 'todoList']) {
    for (const list of ['builder', 'ota']) {
      const result = run(['--list', list], undefined, alias)
      assert.equal(result.status, 0, result.text)
      assert.doesNotMatch(result.text, /\u001B\[|switch list|q\/Esc/, 'non-interactive selection has no terminal controls or color codes')
      if (list === 'builder') {
        assert.match(result.text, /Builder checklist/)
        assert.match(result.text, /Note: You chose guided setup for TestFlight/)
        assert.match(result.text, /Warning: Cloud build failed/)
        assert.doesNotMatch(result.text, /Install Capgo Updater/)
      }
      else {
        assert.match(result.text, /OTA checklist/)
        assert.match(result.text, /Install Capgo Updater/)
        assert.doesNotMatch(result.text, /Prepare your signing keystore/)
      }
    }
  }
  for (const scenario of ['builder-only', 'ota-only']) {
    const result = run([], scenario)
    assert.equal(result.status, 0, result.text)
    assert.match(result.text, scenario === 'builder-only' ? /Builder checklist/ : /OTA checklist/)
    const unavailable = run(['--list', scenario === 'builder-only' ? 'ota' : 'builder'], scenario)
    assert.equal(unavailable.status, 1, unavailable.text)
    assert.match(unavailable.text, /not available/)
    assert.doesNotMatch(unavailable.text, /\[x\] Done|\[ \] Pending/)
  }
  const invalid = run(['--list', 'all'])
  assert.equal(invalid.status, 1, invalid.text)
  assert.match(invalid.text, /builder.*ota/)
  for (const scenario of ['denied', 'two-factor']) {
    const denied = run(['--list', 'builder'], scenario)
    assert.equal(denied.status, 1, denied.text)
    assert.doesNotMatch(denied.text, /\[x\] Done|\[ \] Pending/)
  }
  const partial = run(['--list', 'builder'], 'partial')
  assert.equal(partial.status, 0, partial.text)
  assert.match(partial.text, /Some live progress checks failed/)
  const trialItem = '[ ] Pending: Add a payment method before Jan 1, 2099 so live updates keep reaching devices after the free trial (no charge before then): https://console.capgo.app/settings/organization/plans?trial_card=1'
  const agent = run(['--list', 'ota'], 'trial', 'todo', { CODEX_THREAD_ID: 'fixture-agent-thread', FORCE_COLOR: '1' })
  assert.equal(agent.status, 0, agent.text)
  assert.ok(agent.stdout.includes(`\nApp: ${appId} — Todo list v4 — OTA checklist\n`), agent.stdout)
  assert.ok(agent.stdout.includes(`\n${trialItem}\n`), 'agents get the trial as one plain pending line')
  const agentList = agent.stdout.slice(agent.stdout.indexOf('App: '), agent.stdout.indexOf('Run this command again'))
  assert.doesNotMatch(agentList, /\u001B\[|│/, 'agents get the list without gutter or colors')
  const human = run(['--list', 'ota'], 'trial')
  assert.equal(human.status, 0, human.text)
  assert.doesNotMatch(human.text, /payment method|trial_card/)
  assert.match(human.text, /● {2}App: .+\n│ {2}2\/7 completed/, 'humans keep the styled checklist')
  const help = run(['--help'])
  assert.equal(help.status, 0, help.text)
  assert.match(help.text, /--list <list>/)
  assert.match(help.text, /builder.*ota/)
}
finally {
  rmSync(cwd, { recursive: true, force: true })
}
console.log('Built todo command: selectors, aliases, single-list defaults, non-interactive guidance, agent trial item and access errors passed')
