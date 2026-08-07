import { describe, expect, it } from 'vitest'
import { resolveBillingPaidAt, shouldShowExpiredTrialCopy, shouldShowExpiredTrialPlansState } from '../src/services/paymentRequired'

describe('payment required copy', () => {
  it.concurrent('shows expired-trial copy for a never-paid web organization', () => {
    expect(shouldShowExpiredTrialCopy(false, null)).toBe(true)
  })

  it.concurrent('treats a missing billing relation as never paid', () => {
    expect(resolveBillingPaidAt(null)).toBe(null)
  })

  it.concurrent('keeps subscription copy for a previously paid web organization', () => {
    expect(shouldShowExpiredTrialCopy(false, '2026-01-15T12:00:00.000Z')).toBe(false)
  })

  it.concurrent('keeps existing copy while billing history is unresolved', () => {
    expect(shouldShowExpiredTrialCopy(false, undefined)).toBe(false)
  })

  it.concurrent('never shows purchase-oriented trial copy in the native app', () => {
    expect(shouldShowExpiredTrialCopy(true, null)).toBe(false)
  })

  it.concurrent('shows the plans-page state only for an expired never-paid organization', () => {
    expect(shouldShowExpiredTrialPlansState(true, false, null)).toBe(true)
    expect(shouldShowExpiredTrialPlansState(false, false, null)).toBe(false)
    expect(shouldShowExpiredTrialPlansState(true, false, '2026-01-15T12:00:00.000Z')).toBe(false)
    expect(shouldShowExpiredTrialPlansState(true, false, undefined)).toBe(false)
  })
})
