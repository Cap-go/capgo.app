import { describe, expect, it } from 'vitest'
import { readPlanCheckoutParam, readTrialCardDeepLink } from '../src/utils/billingDeepLinks'

describe('billing deep links', () => {
  it('reads the trial card link and the org it was made for', () => {
    expect(readTrialCardDeepLink({ trial_card: '1', oid: 'org-a' })).toEqual({ orgId: 'org-a' })
    expect(readTrialCardDeepLink({ trial_card: '1' })).toEqual({ orgId: null })
  })

  it('ignores pages without a valid trial card param or with a malformed org', () => {
    expect(readTrialCardDeepLink({ trial_card: '1', oid: ['org-a', 'org-b'] })).toBeNull()
    expect(readTrialCardDeepLink({ trial_card: '1', oid: '' })).toBeNull()
    expect(readTrialCardDeepLink({ trial_card: '1', oid: null })).toBeNull()
    expect(readTrialCardDeepLink({})).toBeNull()
    expect(readTrialCardDeepLink({ oid: 'org-a' })).toBeNull()
    expect(readTrialCardDeepLink({ trial_card: '0', oid: 'org-a' })).toBeNull()
    expect(readTrialCardDeepLink({ trial_card: ['1'], oid: 'org-a' })).toBeNull()
  })

  it('maps the checkout param to a self-serve plan name', () => {
    expect(readPlanCheckoutParam({ plan: 'solo' })).toBe('Solo')
    expect(readPlanCheckoutParam({ plan: 'Maker' })).toBe('Maker')
    expect(readPlanCheckoutParam({ plan: 'TEAM' })).toBe('Team')
    for (const plan of ['enterprise', 'free', 'constructor', '', null, ['team']])
      expect(readPlanCheckoutParam({ plan })).toBeNull()
    expect(readPlanCheckoutParam({})).toBeNull()
  })
})
