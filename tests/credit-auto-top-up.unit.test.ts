import { describe, expect, it } from 'vitest'
import { MIN_AUTO_TOP_UP_THRESHOLD, normalizeAutoTopUpMonthlyLimit, normalizeCycleTopUpAmount, shouldAttemptAutoTopUp } from '../supabase/functions/_backend/utils/credit_auto_top_up.ts'

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

  it.concurrent('ignores the monthly limit when it is 0', () => {
    expect(shouldAttemptAutoTopUp({
      enabled: true,
      availableCredits: 0,
      threshold: 10,
      lastAttemptAt: null,
      monthlyLimit: 0,
      monthlyTotal: 1000,
    })).toBe(true)
  })

  it.concurrent('attempts while the next charge fits in the monthly limit', () => {
    expect(shouldAttemptAutoTopUp({
      enabled: true,
      availableCredits: 0,
      threshold: 10,
      lastAttemptAt: null,
      monthlyLimit: 30,
      monthlyTotal: 20,
    })).toBe(true)
  })

  it.concurrent('stops when the next charge would exceed the monthly limit', () => {
    expect(shouldAttemptAutoTopUp({
      enabled: true,
      availableCredits: 0,
      threshold: 10,
      lastAttemptAt: null,
      monthlyLimit: 25,
      monthlyTotal: 20,
    })).toBe(false)
  })
})

describe('credit auto top-up monthly limit validation', () => {
  it.concurrent('accepts 0 as no limit', () => {
    expect(normalizeAutoTopUpMonthlyLimit(0, 10)).toBe(0)
  })

  it.concurrent('accepts a limit at least equal to the top-up amount', () => {
    expect(normalizeAutoTopUpMonthlyLimit(10, 10)).toBe(10)
    expect(normalizeAutoTopUpMonthlyLimit('100.7', 25)).toBe(100)
  })

  it.concurrent('rejects negative, non-finite, or too-small limits', () => {
    expect(normalizeAutoTopUpMonthlyLimit(-1, 10)).toBeNull()
    expect(normalizeAutoTopUpMonthlyLimit(Number.POSITIVE_INFINITY, 10)).toBeNull()
    expect(normalizeAutoTopUpMonthlyLimit('abc', 10)).toBeNull()
    expect(normalizeAutoTopUpMonthlyLimit(5, 10)).toBeNull()
    expect(normalizeAutoTopUpMonthlyLimit(1_000_000_000_000, 10)).toBeNull()
  })

  it.concurrent('rejects malformed values instead of treating them as no limit', () => {
    expect(normalizeAutoTopUpMonthlyLimit(null, 10)).toBeNull()
    expect(normalizeAutoTopUpMonthlyLimit(false, 10)).toBeNull()
    expect(normalizeAutoTopUpMonthlyLimit('', 10)).toBeNull()
    expect(normalizeAutoTopUpMonthlyLimit('  ', 10)).toBeNull()
  })
})

describe('scheduled top-up amount validation', () => {
  it.concurrent('accepts whole amounts of at least $10', () => {
    expect(normalizeCycleTopUpAmount(600)).toBe(600)
    expect(normalizeCycleTopUpAmount('10.9')).toBe(10)
  })

  it.concurrent('rejects malformed, too small, or too large amounts', () => {
    expect(normalizeCycleTopUpAmount(9)).toBeNull()
    expect(normalizeCycleTopUpAmount(null)).toBeNull()
    expect(normalizeCycleTopUpAmount(false)).toBeNull()
    expect(normalizeCycleTopUpAmount('')).toBeNull()
    expect(normalizeCycleTopUpAmount(1_000_000_000_000)).toBeNull()
  })
})
