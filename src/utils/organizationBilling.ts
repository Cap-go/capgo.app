/** Org with credits but no active paid plan and no trial left. */
export function isCreditsOnlyOrg(org: {
  paying?: boolean | null
  trial_left?: number | null
  credit_available?: number | null
} | null | undefined): boolean {
  if (!org)
    return false
  return !org.paying && (org.trial_left ?? 0) <= 0 && Number(org.credit_available ?? 0) > 0
}
