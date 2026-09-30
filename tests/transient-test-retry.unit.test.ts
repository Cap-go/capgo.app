import { describe, expect, it } from 'vitest'
import { getTransientTestFailure } from '../scripts/run-tests-with-infra-retry.ts'

describe('transient integration test retry classifier', () => {
  it.each([
    ['Unknown Error: An invalid response was received from the upstream server', 'kong_upstream'],
    ['Error: Your worker restarted mid-request', 'workerd_restart'],
    ['AssertionError: expected 502 to be 200 // Object.is equality', 'gateway_502_503'],
    ['AssertionError: expected 503 to be 204 // Object.is equality', 'gateway_502_503'],
  ] as const)('retries %s', (output, expected) => {
    expect(getTransientTestFailure(output)).toBe(expected)
  })

  it.each([
    'AssertionError: expected 500 to be 200',
    'AssertionError: expected true to be false',
    'Edge Function returned a non-2xx status code',
    'Found local migration files to be inserted before the last migration',
    'The job running on runner has exceeded the maximum execution time',
  ])('does not retry %s', (output) => {
    expect(getTransientTestFailure(output)).toBeNull()
  })
})
