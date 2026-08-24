#!/usr/bin/env node
import assert from 'node:assert/strict'
import { categorizeCliError } from '../src/analytics/error-category.ts'
import { categorizeHttpStatus } from '../src/analytics/error-category.ts'
import { isTransientNetworkError } from '../src/shared/network-error.ts'

console.log('🧪 Testing categorizeCliError...\n')

assert.equal(categorizeCliError({ status: 401 }), 'unauthorized')
assert.equal(categorizeCliError({ status: 403 }), 'forbidden')
assert.equal(categorizeCliError({ status: 404 }), 'not_found')
assert.equal(categorizeCliError({ status: 413 }), 'payload_too_large')
assert.equal(categorizeCliError({ status: 500 }), 'server_error')

assert.equal(categorizeCliError(new Error('fetch failed: ECONNREFUSED')), 'network_error')
assert.equal(categorizeCliError(new Error('TypeError: fetch failed')), 'network_error')
assert.equal(categorizeCliError({ message: 'EAI_AGAIN' }), 'network_error')
assert.equal(categorizeCliError(new Error('The operation timed out')), 'timeout')
assert.equal(categorizeCliError(new Error('ETIMEDOUT')), 'timeout')
assert.equal(categorizeCliError(new Error('Invalid app id format')), 'validation_error')
assert.equal(categorizeCliError(new Error('DNS policy misconfiguration for org')), 'unknown')
const nestedNetworkCause = new Error('TypeError: fetch failed', {
  cause: new Error('connect ECONNRESET'),
})
assert.equal(categorizeCliError(nestedNetworkCause), 'network_error')
assert.equal(isTransientNetworkError(nestedNetworkCause), true)

assert.equal(categorizeCliError({ code: 'commander.help' }), 'commander')

assert.equal(categorizeCliError(new Error('something weird')), 'unknown')
assert.equal(categorizeCliError(undefined), 'unknown')

console.log('✅ categorizeCliError tests passed')

console.log('🧪 Testing categorizeHttpStatus...\n')

assert.equal(categorizeHttpStatus(401), 'unauthorized')
assert.equal(categorizeHttpStatus(403), 'forbidden')
assert.equal(categorizeHttpStatus(404), 'not_found')
assert.equal(categorizeHttpStatus(408), 'timeout')
assert.equal(categorizeHttpStatus(504), 'timeout')
assert.equal(categorizeHttpStatus(413), 'payload_too_large')
assert.equal(categorizeHttpStatus(429), 'rate_limited')
assert.equal(categorizeHttpStatus(400), 'validation_error')
assert.equal(categorizeHttpStatus(422), 'validation_error')
assert.equal(categorizeHttpStatus(500), 'server_error')
assert.equal(categorizeHttpStatus(503), 'server_error')
assert.equal(categorizeHttpStatus(499), 'unknown')
assert.equal(categorizeHttpStatus(418), 'unknown')
console.log('✅ categorizeHttpStatus tests passed')
