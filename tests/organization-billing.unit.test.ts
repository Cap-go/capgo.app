import { describe, expect, it } from 'vitest'
import { isCreditsOnlyOrg } from '~/utils/organizationBilling'

describe('isCreditsOnlyOrg', () => {
  it.concurrent('returns true when unpaid, no trial, and credits remain', () => {
    expect(isCreditsOnlyOrg({
      paying: false,
      trial_left: 0,
      credit_available: 120,
    })).toBe(true)
  })

  it.concurrent('returns false when paying', () => {
    expect(isCreditsOnlyOrg({
      paying: true,
      trial_left: 0,
      credit_available: 120,
    })).toBe(false)
  })

  it.concurrent('returns false when trial remains', () => {
    expect(isCreditsOnlyOrg({
      paying: false,
      trial_left: 3,
      credit_available: 120,
    })).toBe(false)
  })

  it.concurrent('returns false when credits are empty', () => {
    expect(isCreditsOnlyOrg({
      paying: false,
      trial_left: 0,
      credit_available: 0,
    })).toBe(false)
  })

  it.concurrent('returns false for null org', () => {
    expect(isCreditsOnlyOrg(null)).toBe(false)
  })
})
