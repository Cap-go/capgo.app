import { describe, expect, it } from 'vitest'
import { shouldShowBuilderPromo } from '~/utils/builderPromoVisibility'

describe('builder promo visibility', () => {
  it('hides the promo when the only organization has no apps', () => {
    expect(shouldShowBuilderPromo({
      organizationCount: 1,
      appCount: 0,
      appNeedsOnboarding: false,
    })).toBe(false)
  })

  it('hides the promo for the only onboarding app in the only organization', () => {
    expect(shouldShowBuilderPromo({
      organizationCount: 1,
      appCount: 1,
      appNeedsOnboarding: true,
    })).toBe(false)
  })

  it('shows the promo when the only app has completed onboarding', () => {
    expect(shouldShowBuilderPromo({
      organizationCount: 1,
      appCount: 1,
      appNeedsOnboarding: false,
    })).toBe(true)
  })

  it('shows the promo when the organization has multiple apps', () => {
    expect(shouldShowBuilderPromo({
      organizationCount: 1,
      appCount: 2,
      appNeedsOnboarding: true,
    })).toBe(true)
  })

  it('shows the promo when the user belongs to multiple organizations', () => {
    expect(shouldShowBuilderPromo({
      organizationCount: 2,
      appCount: 1,
      appNeedsOnboarding: true,
    })).toBe(true)
  })
})
