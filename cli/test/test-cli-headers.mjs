#!/usr/bin/env node
import assert from 'node:assert/strict'
import { buildCliRequestHeaders, validateCliRequestHeaderValue } from '../src/analytics/cli-headers.ts'
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
  'Authorization header contains invalid characters (only ASCII is allowed). Check your Capgo API key or Supabase anon key configuration.',
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
