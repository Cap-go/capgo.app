#!/usr/bin/env node

import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import * as appList from '../src/app/list.ts'
import { findSavedKey } from '../src/utils.ts'

const apps = [
  { app_id: 'com.example.alpha', created_at: '2026-08-20T12:00:00.000Z', name: 'Alpha, "Beta"' },
  { app_id: 'com.example.older', created_at: '2026-08-19T12:00:00.000Z', name: 'Older' },
]

assert.equal(typeof appList.formatAppsCsv, 'function')
assert.equal(typeof appList.formatAppListText, 'function')

const csv = appList.formatAppsCsv(apps)
assert.match(csv, /^Name,id,Created\n/)
assert.match(csv, /"Alpha, ""Beta""",com\.example\.alpha,/)
assert.ok(csv.indexOf('Older') < csv.indexOf('Alpha'), 'preserves the existing oldest-first display order')

const output = appList.formatAppListText(apps)
assert.match(output, /^Getting active bundle in Capgo\n\nActive app in Capgo: 2\n\nApps \(CSV\)\n/)
assert.match(output, /\n\nDone ✅$/)
assert.doesNotMatch(output, /[◇◆│┌└]/)

const originalToken = process.env.CAPGO_TOKEN
try {
  process.env.CAPGO_TOKEN = 'test-output-text-token'
  const messages = []
  assert.equal(findSavedKey(false, message => messages.push(message)), 'test-output-text-token')
  assert.deepEqual(messages, ['Use CAPGO_TOKEN environment variable'])
}
finally {
  if (originalToken === undefined)
    delete process.env.CAPGO_TOKEN
  else
    process.env.CAPGO_TOKEN = originalToken
}

const builtCli = new URL('../dist/index.js', import.meta.url)
const cliSource = new URL('../src/index.ts', import.meta.url)
assert.equal(existsSync(builtCli), true, 'Run `bun run build` before this test')
assert.ok(statSync(builtCli).mtimeMs >= statSync(cliSource).mtimeMs, 'Run `bun run build` before this test; dist/index.js is stale')

const help = spawnSync(process.execPath, [builtCli.pathname, 'app', 'list', '--help'], { encoding: 'utf8' })
assert.equal(help.status, 0, help.stderr)
assert.match(help.stdout, /--output-text\b/)

const unrelatedHelp = spawnSync(process.execPath, [builtCli.pathname, 'bundle', 'delete', '--help'], { encoding: 'utf8' })
assert.equal(unrelatedHelp.status, 0, unrelatedHelp.stderr)
assert.doesNotMatch(unrelatedHelp.stdout, /--output-text\b/)

console.log('✅ App list plain-text output checks passed')
