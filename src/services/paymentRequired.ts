export function resolveBillingPaidAt(stripeInfo: { paid_at: string | null } | null): string | null {
  return stripeInfo?.paid_at ?? null
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
