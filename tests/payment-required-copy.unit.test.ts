import { describe, expect, it } from 'vitest'
import { isZeroLengthTrial, resolveBillingPaidAt, shouldShowExpiredTrialCopy, shouldShowExpiredTrialPlansState, shouldShowPlanFailureBanner } from '../src/services/paymentRequired'

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

  it.concurrent('keeps the plans failure banner neutral while billing history loads', () => {
    expect(shouldShowPlanFailureBanner(true, false, undefined)).toBe(false)
  })

  it.concurrent('shows the plans failure banner only for resolved non-trial failures', () => {
    expect(shouldShowPlanFailureBanner(true, false, null)).toBe(false)
    expect(shouldShowPlanFailureBanner(true, false, '2026-01-15T12:00:00.000Z')).toBe(true)
    expect(shouldShowPlanFailureBanner(false, false, '2026-01-15T12:00:00.000Z')).toBe(false)
    expect(shouldShowPlanFailureBanner(true, true, undefined)).toBe(true)
    expect(shouldShowPlanFailureBanner(true, false, undefined, true)).toBe(true)
  })

  it.concurrent('detects orgs created without a free trial', () => {
    const createdAt = '2026-10-20T12:00:00.000Z'
    expect(isZeroLengthTrial(createdAt, '2026-10-20T12:00:00.500Z')).toBe(true)
    expect(isZeroLengthTrial(createdAt, '2026-10-20T11:59:59.000Z')).toBe(true)
    expect(isZeroLengthTrial(createdAt, '2026-11-04T12:00:00.000Z')).toBe(false)
    // A trial end far before creation is not a skipped trial either.
    expect(isZeroLengthTrial(createdAt, '2026-01-01T00:00:00.000Z')).toBe(false)
    expect(isZeroLengthTrial(createdAt, null)).toBe(false)
    expect(isZeroLengthTrial(null, '2026-10-20T12:00:00.000Z')).toBe(false)
    expect(isZeroLengthTrial(createdAt, 'not-a-date')).toBe(false)
  })
})
