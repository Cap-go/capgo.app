export function resolveBillingPaidAt(stripeInfo: { paid_at: string | null } | null): string | null {
  return stripeInfo?.paid_at ?? null
}

export function shouldShowExpiredTrialCopy(isNative: boolean, paidAt: string | null | undefined): boolean {
  return !isNative && paidAt === null
}
