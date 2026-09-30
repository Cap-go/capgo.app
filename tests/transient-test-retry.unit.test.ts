import { describe, expect, it } from 'vitest'
import { getTransientTestFailure } from '../scripts/run-tests-with-infra-retry.ts'

describe('transient integration test retry classifier', () => {
  it.each([
    ['FAIL tests/example.test.ts > example\nUnknown Error: An invalid response was received from the upstream server', 'kong_upstream'],
    ['FAIL tests/example.test.ts > example\nError: Your worker restarted mid-request', 'workerd_restart'],
    ['FAIL tests/example.test.ts > example\nAssertionError: expected 502 to be 200 // Object.is equality', 'gateway_502_503'],
    ['FAIL tests/example.test.ts > example\nAssertionError: expected 503 to be 204 // Object.is equality', 'gateway_502_503'],
  ] as const)('retries %s', (output, expected) => {
    expect(getTransientTestFailure(output)).toBe(expected)
  })

  it.each([
    'FAIL tests/example.test.ts > example\nAssertionError: expected 500 to be 200',
    'FAIL tests/example.test.ts > example\nAssertionError: expected true to be false',
    'Edge Function returned a non-2xx status code',
    'Found local migration files to be inserted before the last migration',
    'The job running on runner has exceeded the maximum execution time',
  ])('does not retry %s', (output) => {
    expect(getTransientTestFailure(output)).toBeNull()
  })

  it('does not retry mixed transient and ordinary test failures', () => {
    const output = [
      'FAIL tests/transient.test.ts > transient',
      'AssertionError: expected 502 to be 200',
      'FAIL tests/product.test.ts > product assertion',
      'AssertionError: expected true to be false',
    ].join('\n')

    expect(getTransientTestFailure(output)).toBeNull()
  })

  it('ignores transient messages emitted by passing tests', () => {
    const output = [
      'stderr | tests/passing.test.ts > passes',
      'Your worker restarted mid-request',
      '✓ tests/passing.test.ts',
      'FAIL tests/product.test.ts > product assertion',
      'AssertionError: expected 500 to be 200',
    ].join('\n')

    expect(getTransientTestFailure(output)).toBeNull()
  })
})
