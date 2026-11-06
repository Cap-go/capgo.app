import { describe, expect, it } from 'vitest'
import { shouldShowBuilderPromo } from '~/utils/builderPromoVisibility'

describe('builder promo visibility', () => {
  it.each([
    { name: 'hides when the only organization has no apps', organizationCount: 1, appCount: 0, appNeedsOnboarding: false, expected: false },
    { name: 'hides for the only onboarding app in the only organization', organizationCount: 1, appCount: 1, appNeedsOnboarding: true, expected: false },
    { name: 'shows when the only app has completed onboarding', organizationCount: 1, appCount: 1, appNeedsOnboarding: false, expected: true },
    { name: 'shows when the organization has multiple apps', organizationCount: 1, appCount: 2, appNeedsOnboarding: true, expected: true },
    { name: 'shows when the user belongs to multiple organizations', organizationCount: 2, appCount: 1, appNeedsOnboarding: true, expected: true },
  ])('$name', ({ expected, name: _name, ...input }) => {
    expect(shouldShowBuilderPromo(input)).toBe(expected)
  })
})
