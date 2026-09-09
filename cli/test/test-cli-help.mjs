#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const cliDir = new URL('..', import.meta.url)

function getHelp(...command) {
  const result = spawnSync(process.execPath, ['dist/index.js', ...command, '--help'], {
    cwd: cliDir,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

const buildHelp = getHelp('build')
assert.match(buildHelp, /Build native iOS and Android apps with Capgo Cloud\./)
assert.match(buildHelp, /Quick start:/)
assert.match(buildHelp, /needed \[options\] \[appId\]\s+Check whether a native build is required/)
assert.match(buildHelp, /request \[options\] \[appId\]\s+Request a native build from Capgo Cloud/)
assert.match(buildHelp, /credentials\s+Manage locally saved build credentials/)
assert.doesNotMatch(buildHelp, /SECURITY GUARANTEE|CAPTURE THE OUTPUT|The project is zipped/)
assert.ok(buildHelp.trimEnd().split('\n').length < 40, 'build help should remain compact')

const credentialsHelp = getHelp('build', 'credentials')
assert.match(credentialsHelp, /Credentials are stored in ~\/\.capgo-credentials\/credentials\.json globally/)
assert.match(credentialsHelp, /ios-provisioning \[options\]\s+Set up profiles for every signable iOS target/)
assert.match(credentialsHelp, /save \[options\]\s+Save iOS or Android build credentials/)
assert.match(credentialsHelp, /export \[options\] <variable>\s+Export one saved credential value/)
assert.doesNotMatch(credentialsHelp, /Opens a native window|Reuses an eligible saved wildcard profile|iOS Example/)
assert.ok(credentialsHelp.trimEnd().split('\n').length < 45, 'credentials help should remain compact')

const requestHelp = getHelp('build', 'request')
for (const heading of [
  'General options:',
  'iOS options:',
  'Android options:',
  'Store options:',
  'Output and version options:',
  'Prescan and diagnostics options:',
  'Capgo options:',
]) {
  assert.match(requestHelp, new RegExp(heading))
}

const saveHelp = getHelp('build', 'credentials', 'save')
const updateHelp = getHelp('build', 'credentials', 'update')
for (const help of [saveHelp, updateHelp]) {
  assert.match(help, /General options:/)
  assert.match(help, /iOS options:/)
  assert.match(help, /Android options:/)
  assert.match(help, /Build defaults:/)
}

for (const help of [buildHelp, credentialsHelp, requestHelp, saveHelp, updateHelp]) {
  assert.doesNotMatch(help, /npx @capgo\/cli(?!@latest)/)
}

console.log('✅ CLI help readability checks passed')
