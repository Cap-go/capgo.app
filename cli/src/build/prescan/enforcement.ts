import type { Finding, PrescanReport, Severity } from './types'

type EnforcementReport = Pick<PrescanReport, 'counts' | 'findings'>

export function isFindingEnforced(finding: Finding, now: Date = new Date()): boolean {
  if (!finding.enforceAfter)
    return true
  const deadline = Date.parse(finding.enforceAfter)
  return Number.isNaN(deadline) || now.getTime() >= deadline
}

export function informationOnlyFindings(report: EnforcementReport, now: Date = new Date()): Finding[] {
  return report.findings.filter(finding => !isFindingEnforced(finding, now))
}

export function enforcedCounts(report: EnforcementReport, now: Date = new Date()): Record<Severity, number> {
  // Counts-only synthetic callers predate rollout metadata. Preserve their
  // contract when no finding carries a scheduled enforcement date.
  if (!report.findings.some(finding => finding.enforceAfter))
    return report.counts

  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 }
  for (const finding of report.findings) {
    if (isFindingEnforced(finding, now))
      counts[finding.severity]++
  }
  return counts
}

export function formatEnforcementDeadline(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime()))
    return iso
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
