export interface BuilderPromoVisibilityContext {
  organizationCount: number
  appCount: number
  appNeedsOnboarding: boolean
}

export function shouldShowBuilderPromo({
  organizationCount,
  appCount,
  appNeedsOnboarding,
}: BuilderPromoVisibilityContext) {
  const isSingleOrganizationOnboarding = organizationCount === 1
    && (appCount === 0 || (appCount === 1 && appNeedsOnboarding))

  return !isSingleOrganizationOnboarding
}
