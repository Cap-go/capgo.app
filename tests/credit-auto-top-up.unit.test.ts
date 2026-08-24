import { describe, expect, it } from 'vitest'
import { MIN_AUTO_TOP_UP_THRESHOLD, shouldAttemptAutoTopUp } from '../supabase/functions/_backend/utils/credit_auto_top_up.ts'

describe('credit auto top-up decision', () => {
  it('does not attempt when disabled', () => {
    expect(shouldAttemptAutoTopUp({
      enabled: false,
      availableCredits: 0,
      threshold: 10,
      lastAttemptAt: null,
    })).toBe(false)
  })

  it('does not attempt when available credits are at or above the threshold', () => {
    expect(shouldAttemptAutoTopUp({
      enabled: true,
      availableCredits: 10,
      threshold: 10,
      lastAttemptAt: null,
    })).toBe(false)
  })

  it('does not attempt below the $10 minimum threshold', () => {
    expect(shouldAttemptAutoTopUp({
      enabled: true,
      availableCredits: 0,
      threshold: 9,
      lastAttemptAt: null,
    })).toBe(false)
    expect(MIN_AUTO_TOP_UP_THRESHOLD).toBe(10)
  })

  it('attempts when enabled, below threshold, and off cooldown', () => {
    expect(shouldAttemptAutoTopUp({
      enabled: true,
      availableCredits: 3,
      threshold: 10,
      lastAttemptAt: null,
    })).toBe(true)
  })

  it('does not attempt during the cooldown window', () => {
    const now = Date.parse('2026-08-24T12:00:00.000Z')
    expect(shouldAttemptAutoTopUp({
      enabled: true,
      availableCredits: 0,
      threshold: 10,
      lastAttemptAt: '2026-08-24T11:30:00.000Z',
      now,
    })).toBe(false)
  })

  it.concurrent('attempts again after the cooldown window ends', () => {
    const now = Date.parse('2026-08-24T12:00:00.000Z')
    expect(shouldAttemptAutoTopUp({
      enabled: true,
      availableCredits: 0,
      threshold: 10,
      lastAttemptAt: '2026-08-24T10:59:00.000Z',
      now,
    })).toBe(true)
  })

  it.concurrent('attempts when the last attempt timestamp is unparsable', () => {
    expect(shouldAttemptAutoTopUp({
      enabled: true,
      availableCredits: 0,
      threshold: 10,
      lastAttemptAt: 'not-a-date',
    })).toBe(true)
  })
})
