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
