#!/usr/bin/env node
import assert from 'node:assert/strict'
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

console.log('✅ authenticated command invocation tests passed')
