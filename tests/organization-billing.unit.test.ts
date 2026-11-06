import { describe, expect, it } from 'vitest'
import { isCreditsOnlyOrg, resolveOrgBillingStatus } from '~/utils/organizationBilling'

const visibleOptions = {
  stripeEnabled: true,
  lacksSecurityAccess: false,
  organizationFailed: false,
}

describe('isCreditsOnlyOrg', () => {
  it.concurrent.each([
    ['unpaid, no trial, and credits remain', { paying: false, trial_left: 0, credit_available: 120 }, true],
    ['paying', { paying: true, trial_left: 0, credit_available: 120 }, false],
    ['trial remains', { paying: false, trial_left: 3, credit_available: 120 }, false],
    ['credits are empty', { paying: false, trial_left: 0, credit_available: 0 }, false],
    ['null org', null, false],
  ])('when %s', (_label, org, expected) => {
    expect(isCreditsOnlyOrg(org)).toBe(expected)
  })
})

describe('resolveOrgBillingStatus', () => {
  it.concurrent.each([
    ['stripe is disabled', { stripeEnabled: false }],
    ['security access is missing', { lacksSecurityAccess: true }],
  ])('hides when %s', (_label, options) => {
    expect(resolveOrgBillingStatus({ paying: false, trial_left: 10 }, {
      ...visibleOptions,
      ...options,
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

  it.concurrent.each([
    ['one day of trial stays trial, not inactive', { paying: false, trial_left: 1, can_use_more: true }, 'trial'],
    ['a paid org over quota without credits', { paying: true, trial_left: 0, can_use_more: false, credit_available: 0 }, 'limit_reached'],
    ['a paid org over quota with credits', { paying: true, trial_left: 0, can_use_more: false, credit_available: 40 }, 'limit_reached_credits'],
  ])('resolves %s', (_label, org, kind) => {
    expect(resolveOrgBillingStatus(org, visibleOptions).kind).toBe(kind)
  })
})
