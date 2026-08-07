export function shouldShowExpiredTrialCopy(isNative: boolean, paidAt: string | null | undefined): boolean {
  return !isNative && paidAt === null
}
