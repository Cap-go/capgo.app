// Foreground billing checks and the optional footer share this process-local
// state. A worker's billing read must not count as a displayed trial notice.
const shownOrgs = new Set<string>()

export function markTrialNoticeShown(orgId: string): void {
  shownOrgs.add(orgId)
}

export function wasTrialNoticeShown(orgId: string): boolean {
  return shownOrgs.has(orgId)
}
