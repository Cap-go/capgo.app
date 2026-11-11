#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { buildCliRequestHeaders, cliCiHeaderValue, validateCliRequestHeaderValue } from '../src/analytics/cli-headers.ts'
import { CliUserError } from '../src/shared/cli-user-error.ts'

console.log('🧪 Testing CLI request header validation...\n')

function assertCliUserError(fn, expectedMessage) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof CliUserError, true, 'expected CliUserError')
    assert.equal(error.message, expectedMessage)
    assert.equal(error.name, 'CliUserError')
    return true
  })
}

// Non-ASCII API key must not reach undici Headers (Cyrillic chars from PostHog issue).
const cyrillicKey = 'капго_ключ'
assertCliUserError(
  () => buildCliRequestHeaders({ capgkey: cyrillicKey }),
  'Capgo API key contains invalid characters (only ASCII is allowed). Copy the key from the Capgo dashboard.',
)

assertCliUserError(
  () => buildCliRequestHeaders({ Authorization: cyrillicKey }),
  'Authorization header contains invalid characters (only ASCII is allowed). Check your Capgo API key configuration.',
)

// Undefined API key headers must fail before fetch, not as undici TypeError.
assertCliUserError(
  () => buildCliRequestHeaders({ capgkey: undefined }),
  'Capgo API key is missing. Run `npx -y @capgo/cli@latest login` or pass `--apikey`.',
)

assertCliUserError(
  () => buildCliRequestHeaders({ Authorization: undefined }),
  'Capgo API key is missing. Run `npx -y @capgo/cli@latest login` or pass `--apikey`.',
)

// Happy path unchanged for valid ASCII keys and metadata headers.
const headers = buildCliRequestHeaders({
  capgkey: 'capg_0123456789abcdef',
  Authorization: 'capg_0123456789abcdef',
  'Content-Type': 'application/json',
})
assert.equal(headers.capgkey, 'capg_0123456789abcdef')
assert.equal(headers.Authorization, 'capg_0123456789abcdef')
assert.equal(headers['Content-Type'], 'application/json')
assert.equal(typeof headers['x-cli-version'], 'string')
assert.equal(typeof headers.capgo_api, 'string')

// CI runs report their CI so Capgo can mark the onboarding CI/CD step done.
assert.equal(cliCiHeaderValue(false, 'GitHub Actions'), undefined)
assert.equal(cliCiHeaderValue(true, 'GitHub Actions'), 'GitHub Actions')
assert.equal(cliCiHeaderValue(true, null), 'ci')
assert.equal(cliCiHeaderValue(true, 'Ünïcode CI'), 'ncode CI')
assert.equal(cliCiHeaderValue(true, 'x'.repeat(80)).length, 64)

// ci-info reads its environment at import time, so construct requests in isolated processes.
for (const [environment, expectedProvider] of [
  [{ CI: 'true', GITHUB_ACTIONS: 'true' }, 'GitHub Actions'],
  [{ CI: 'true' }, 'ci'],
  [{ CI: 'false' }, undefined],
]) {
  const result = spawnSync(process.execPath, ['--eval', `
    import { buildCliRequestHeaders } from ${JSON.stringify(new URL('../src/analytics/cli-headers.ts', import.meta.url).href)}
    process.stdout.write(JSON.stringify(buildCliRequestHeaders()))
  `], { env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, ...environment }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout)['x-cli-ci'], expectedProvider)
}

// Bearer tokens stay valid when ASCII-only.
const bearerHeaders = buildCliRequestHeaders({
  Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test',
})
assert.equal(bearerHeaders.Authorization.startsWith('Bearer '), true)

// Non-auth headers get a generic message without leaking values.
assertCliUserError(
  () => validateCliRequestHeaderValue('x-custom', 'тест'),
  'HTTP header "x-custom" contains invalid characters (only ASCII is allowed).',
)

assertCliUserError(
  () => validateCliRequestHeaderValue('Content-Type', undefined),
  'HTTP header "Content-Type" is missing or invalid.',
)

// Reproduce undici failure mode: new Headers must not throw for validated output.
assert.doesNotThrow(() => new Headers(buildCliRequestHeaders({ capgkey: 'capg_valid_key' })))

assert.throws(
  () => new Headers({ capgkey: cyrillicKey }),
  (error) => error instanceof TypeError,
  'fetch/undici should still throw TypeError for unvalidated Cyrillic header values',
)

console.log('CLI request header validation tests passed')
