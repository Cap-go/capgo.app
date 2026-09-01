#!/usr/bin/env node

import assert from 'node:assert/strict'
import { MIN_CLI_VERSION } from '../../supabase/functions/_backend/utils/cliMinVersion.ts'
import pack from '../package.json'
import { assertMinCliVersion, formatMinCliVersionMessage, isCliVersionBelowMin } from '../src/api/min-cli-version.ts'
import { CliUserError } from '../src/shared/cli-user-error.ts'

console.log('🧪 Testing CLI min version gate...\n')

assert.equal(isCliVersionBelowMin('8.43.0', '8.43.1'), true)
assert.equal(isCliVersionBelowMin('8.43.1', '8.43.1'), false)
assert.equal(isCliVersionBelowMin('8.44.0', '8.43.1'), false)
assert.equal(isCliVersionBelowMin('not-semver', '8.43.1'), false)
assert.equal(isCliVersionBelowMin('8.43.1', 'not-semver'), false)
assert.equal(isCliVersionBelowMin(pack.version, MIN_CLI_VERSION), false, `workspace CLI ${pack.version} must be >= min ${MIN_CLI_VERSION}`)

assertMinCliVersion({}, '8.0.0')
assertMinCliVersion({ minCliVersion: '  ' }, '8.0.0')
assertMinCliVersion({ minCliVersion: '8.43.1' }, '8.43.1')
assertMinCliVersion({ minCliVersion: '8.43.1' }, '8.44.0')

const reason = 'Security: hashed API keys are required.'
try {
  assertMinCliVersion({ minCliVersion: '8.43.1', minCliVersionReason: reason }, '8.42.0', true)
  assert.fail('expected CliUserError')
}
catch (error) {
  assert.equal(error instanceof CliUserError, true)
  assert.equal(error.message, formatMinCliVersionMessage('8.42.0', '8.43.1', reason))
  assert.equal(error.context.minCliVersion, '8.43.1')
  assert.equal(error.context.currentVersion, '8.42.0')
  assert.equal(error.message.includes(reason), true)
  assert.equal(error.message.includes('npx @capgo/cli@latest'), true)
}

console.log('✅ CLI min version gate tests passed')
