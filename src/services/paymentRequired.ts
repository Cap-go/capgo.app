export function resolveBillingPaidAt(stripeInfo: { paid_at: string | null } | null): string | null {
  return stripeInfo?.paid_at ?? null
}

// Normal trials last 15 days. A trial ending within a day of org creation means
// the org never had one (direct-offer / paid-ads signups must subscribe first).
// trial_at is written in the same transaction as the org insert (DB trigger) or
// by the org-create API, so in practice it never lags creation by a day.
const ZERO_LENGTH_TRIAL_MAX_MS = 24 * 60 * 60 * 1000

/** True when the org was created without a free trial (trial_at ~= org created_at). */
export function isZeroLengthTrial(orgCreatedAt: string | null | undefined, trialAt: string | null | undefined): boolean {
  if (!orgCreatedAt || !trialAt)
    return false
  const created = Date.parse(orgCreatedAt)
  const trialEnd = Date.parse(trialAt)
  if (Number.isNaN(created) || Number.isNaN(trialEnd))
    return false
  return Math.abs(trialEnd - created) <= ZERO_LENGTH_TRIAL_MAX_MS
}

export function shouldShowExpiredTrialCopy(isNative: boolean, paidAt: string | null | undefined): boolean {
  return !isNative && paidAt === null
}

export function shouldShowExpiredTrialPlansState(currentOrganizationFailed: boolean, isNative: boolean, paidAt: string | null | undefined): boolean {
  return currentOrganizationFailed && shouldShowExpiredTrialCopy(isNative, paidAt)
}

export function shouldShowPlanFailureBanner(
  currentOrganizationFailed: boolean,
  isNative: boolean,
  paidAt: string | null | undefined,
  billingLookupFailed = false,
): boolean {
  return currentOrganizationFailed
    && (isNative || billingLookupFailed || paidAt !== undefined)
    && !shouldShowExpiredTrialPlansState(currentOrganizationFailed, isNative, paidAt)
}

export const DIRECT_OFFER = 'direct'

export type UnpaidCopyVariant = 'no_trial' | 'expired_trial' | 'lapsed' | 'native'

export type OnboardingPlanSubtitleKey
  = | 'ai-onboarding-plan-subtitle'
    | 'ai-onboarding-plan-subtitle-no-trial'
    | 'invite-onboarding-plan-subtitle'
    | 'invite-onboarding-plan-subtitle-no-trial'

/** True when auth app_metadata marks a paid-ads (direct offer) signup. */
export function isDirectOfferMetadata(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.offer === DIRECT_OFFER
}

/**
 * Copy variant for unpaid-org surfaces. Does not change gating.
 * Fresh orgs that never had a trial see "choose a plan to start shipping".
 * Expired trials and lapsed subscriptions keep their existing copy.
 * While billing history is still loading, keep the existing lapsed copy unless
 * the user is a known direct-offer signup, so ad visitors do not see a
 * suspension message first.
 */
export function resolveUnpaidCopyVariant(options: {
  isNative: boolean
  paidAt: string | null | undefined
  trialSkipped: boolean
  isDirectOfferUser?: boolean
}): UnpaidCopyVariant {
  if (options.isNative)
    return 'native'
  const neverPaid = options.paidAt === null || options.paidAt === undefined
  if (options.trialSkipped || (options.isDirectOfferUser === true && neverPaid))
    return 'no_trial'
  if (options.paidAt === null)
    return 'expired_trial'
  return 'lapsed'
}

/** Plan-step subtitle for AI or invite onboarding. Direct-offer users never see trial copy. */
export function onboardingPlanSubtitleKey(options: {
  isInvite: boolean
  isDirectOfferUser: boolean
}): OnboardingPlanSubtitleKey {
  if (options.isDirectOfferUser) {
    return options.isInvite
      ? 'invite-onboarding-plan-subtitle-no-trial'
      : 'ai-onboarding-plan-subtitle-no-trial'
  }
  return options.isInvite
    ? 'invite-onboarding-plan-subtitle'
    : 'ai-onboarding-plan-subtitle'
}
