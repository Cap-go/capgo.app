import { describe, expect, it } from 'vitest'
import { isCreditsOnlyOrg, resolveOrgBillingStatus } from '~/utils/organizationBilling'

const visibleOptions = {
  stripeEnabled: true,
  lacksSecurityAccess: false,
  organizationFailed: false,
}

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

describe('resolveOrgBillingStatus', () => {
  it.concurrent('hides when stripe is disabled', () => {
    expect(resolveOrgBillingStatus({ paying: false, trial_left: 10 }, {
      ...visibleOptions,
      stripeEnabled: false,
    }).kind).toBe('hidden')
  })

  it.concurrent('hides when security access is missing', () => {
    expect(resolveOrgBillingStatus({ paying: false, trial_left: 10 }, {
      ...visibleOptions,
      lacksSecurityAccess: true,
    }).kind).toBe('hidden')
  })

  it.concurrent('shows remaining trial days even when stripe status is canceled', () => {
    expect(resolveOrgBillingStatus({
      paying: false,
      trial_left: 14,
      can_use_more: true,
    }, visibleOptions)).toMatchObject({
      kind: 'trial',
      trialDaysLeft: 14,
      tone: 'trial',
      cta: 'go_plans',
    })
  })

  it.concurrent('keeps one day of trial as trial, not inactive', () => {
    expect(resolveOrgBillingStatus({
      paying: false,
      trial_left: 1,
      can_use_more: true,
    }, visibleOptions).kind).toBe('trial')
  })

  it.concurrent('shows trial over when the trial has ended', () => {
    expect(resolveOrgBillingStatus({
      paying: false,
      trial_left: 0,
      can_use_more: false,
      credit_available: 0,
    }, {
      ...visibleOptions,
      organizationFailed: true,
    })).toMatchObject({
      kind: 'trial_over',
      cta: 'go_plans',
      tone: 'warning',
    })
  })

  it.concurrent('shows plan active for a healthy paid org', () => {
    expect(resolveOrgBillingStatus({
      paying: true,
      trial_left: 0,
      can_use_more: true,
    }, visibleOptions)).toMatchObject({
      kind: 'plan_active',
      cta: 'none',
      tone: 'success',
    })
  })

  it.concurrent('shows using credits for credits-only orgs', () => {
    expect(resolveOrgBillingStatus({
      paying: false,
      trial_left: 0,
      credit_available: 80,
      can_use_more: true,
    }, visibleOptions)).toMatchObject({
      kind: 'using_credits',
      cta: 'go_credits',
    })
  })

  it.concurrent('shows plan limit reached when a paid org is over quota without credits', () => {
    expect(resolveOrgBillingStatus({
      paying: true,
      trial_left: 0,
      can_use_more: false,
      credit_available: 0,
    }, visibleOptions).kind).toBe('limit_reached')
  })

  it.concurrent('shows using credits when a paid org is over quota with credits', () => {
    expect(resolveOrgBillingStatus({
      paying: true,
      trial_left: 0,
      can_use_more: false,
      credit_available: 40,
    }, visibleOptions).kind).toBe('limit_reached_credits')
  })
})
