import { describe, expect, it } from 'vitest'
import { classifyBuildTransition, mapBuildFailureCategory } from '../supabase/functions/_backend/utils/build_tracking.ts'
import { getBuilderXcodeVersion } from '../supabase/functions/_backend/utils/builder_machine.ts'

describe('classifyBuildTransition', () => {
  it.concurrent.each([
    ['pending', 'running', false, 'started'],
    ['queued', 'running', false, 'started'],
    ['running', 'succeeded', false, 'succeeded'],
    ['pending', 'succeeded', false, 'succeeded'],
    ['running', 'failed', false, 'failed'],
    ['running', 'failed', true, 'timed_out'],
    ['running', 'succeeded', true, 'timed_out'],
    // timeout overrides no-change
    ['running', 'running', true, 'timed_out'],
    // previous already terminal (idempotency), even with timeoutApplied
    ['succeeded', 'succeeded', false, null],
    ['failed', 'failed', false, null],
    ['cancelled', 'cancelled', false, null],
    ['expired', 'expired', false, null],
    ['released', 'released', false, null],
    ['failed', 'failed', true, null],
    // no state change
    ['pending', 'pending', false, null],
    ['running', 'running', false, null],
  ] as const)('%s -> %s (timeoutApplied=%s) is %s', (previous, next, timeoutApplied, expected) => {
    expect(classifyBuildTransition({ previous, next, timeoutApplied })).toBe(expected)
  })
})

describe('mapBuildFailureCategory', () => {
  it.concurrent('returns timeout when the timeout flag is set', () => {
    expect(mapBuildFailureCategory({ timeoutApplied: true, errorMessage: null })).toBe('timeout')
  })

  it.concurrent('returns validation_error for validation-style messages', () => {
    expect(mapBuildFailureCategory({ timeoutApplied: false, errorMessage: 'Invalid build_mode value' })).toBe('validation_error')
    expect(mapBuildFailureCategory({ timeoutApplied: false, errorMessage: 'missing credentials' })).toBe('validation_error')
  })

  it.concurrent('returns builder_error when there is any other non-empty error', () => {
    expect(mapBuildFailureCategory({ timeoutApplied: false, errorMessage: 'gradle compile failed' })).toBe('builder_error')
  })

  it.concurrent('returns unknown when timeoutApplied is false and error is empty', () => {
    expect(mapBuildFailureCategory({ timeoutApplied: false, errorMessage: null })).toBe('unknown')
    expect(mapBuildFailureCategory({ timeoutApplied: false, errorMessage: '' })).toBe('unknown')
  })
})

describe('getBuilderXcodeVersion', () => {
  it.concurrent('reads the Xcode version reported by the builder', () => {
    expect(getBuilderXcodeVersion({ backend: 'mac', xcode_version: '26.1', macos_version: '15.6' })).toBe('26.1')
    expect(getBuilderXcodeVersion({ backend: 'linux', xcode_version: '27' })).toBe('27')
  })

  it.concurrent('ignores missing or malformed versions', () => {
    expect(getBuilderXcodeVersion(null)).toBeNull()
    expect(getBuilderXcodeVersion({})).toBeNull()
    expect(getBuilderXcodeVersion({ xcode_version: 26 })).toBeNull()
    expect(getBuilderXcodeVersion({ xcode_version: 'Xcode 26.1' })).toBeNull()
  })
})
