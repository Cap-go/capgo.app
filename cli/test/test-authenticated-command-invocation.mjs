#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveInitCommandInput, resolveLoginCommandApiKey } from '../src/auth/command-input.ts'

console.log('🧪 Testing authenticated command invocation...\n')

assert.equal(resolveLoginCommandApiKey('positional-key', 'flag-key'), 'flag-key')
assert.equal(resolveLoginCommandApiKey('positional-key', undefined), 'positional-key')
assert.equal(resolveLoginCommandApiKey(undefined, '  flag-key  '), 'flag-key')

assert.deepEqual(resolveInitCommandInput('legacy-key', 'com.example.app', undefined), {
  apikey: 'legacy-key',
  appId: 'com.example.app',
  explicitApiKey: true,
})
assert.deepEqual(resolveInitCommandInput('com.example.app', undefined, 'flag-key'), {
  apikey: 'flag-key',
  appId: 'com.example.app',
  explicitApiKey: true,
})
assert.deepEqual(resolveInitCommandInput('ignored-key', 'com.example.app', 'flag-key'), {
  apikey: 'flag-key',
  appId: 'com.example.app',
  explicitApiKey: true,
})
assert.deepEqual(resolveInitCommandInput(undefined, undefined, undefined), {
  apikey: undefined,
  appId: undefined,
  explicitApiKey: false,
})

const testDir = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(join(testDir, '../src/index.ts'), 'utf8')
const loginSource = readFileSync(join(testDir, '../src/login.ts'), 'utf8')
const initSource = readFileSync(join(testDir, '../src/init/command.ts'), 'utf8')

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`)
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`)
  return source.slice(startIndex, endIndex)
}

const preActionSource = sourceBetween(indexSource, "program.hook('preAction'", "program.hook('postAction'")
assert.match(preActionSource, /currentCommandPath === 'login'/)
assert.match(preActionSource, /currentCommandPath === 'init'/)
assert.match(preActionSource, /deferCommandInvocation\(currentCommandPath, commandContext\)/)

const initCommandSource = sourceBetween(indexSource, ".command('init [apikey] [appId]')", "program\n  .command('doctor')")
const loginCommandSource = sourceBetween(indexSource, ".command('login [apikey]')", "program\n  .command('get-qr")
assert.match(initCommandSource, /\.option\('-a, --apikey <apikey>', optionDescriptions\.apikey\)/)
assert.match(loginCommandSource, /\.option\('-a, --apikey <apikey>', optionDescriptions\.apikey\)/)

const loginActionSource = sourceBetween(loginSource, 'export async function login(', '\n}')
const loginValidationIndex = loginActionSource.indexOf('await loginInternal(')
const loginInvocationIndex = loginActionSource.indexOf('flushDeferredCommandInvocation(')
assert.ok(loginValidationIndex >= 0, 'login action validates and saves the selected key')
assert.ok(loginInvocationIndex > loginValidationIndex, 'login invocation is emitted only after validation')

const initActionStart = initSource.indexOf('export async function initApp(')
assert.notEqual(initActionStart, -1, 'missing init action')
const initActionSource = initSource.slice(initActionStart)
const initValidationIndex = initActionSource.indexOf('await resolveUserIdFromApiKey(')
const initInvocationIndex = initActionSource.indexOf('flushDeferredCommandInvocation(')
const initSavedKeyFallbackIndex = initActionSource.indexOf('options.apikey = findSavedKey(true)')
assert.ok(initActionSource.includes('resolveInitCommandInput('), 'init resolves flag and positional input explicitly')
assert.ok(initSavedKeyFallbackIndex >= 0, 'init replaces an absent or empty command key with the saved key')
assert.ok(initSavedKeyFallbackIndex < initValidationIndex, 'init restores its saved-key fallback before validation')
assert.ok(initValidationIndex >= 0, 'init validates the selected key with Capgo')
assert.ok(initInvocationIndex > initValidationIndex, 'init invocation is emitted only after validation')

console.log('✅ authenticated command invocation tests passed')
