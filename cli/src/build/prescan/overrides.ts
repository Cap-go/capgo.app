// src/build/prescan/overrides.ts
//
// Per-check CLI overrides: skip a check entirely, or downgrade its findings
// to warning so the rest of the scan still runs and reports.
import type { Finding, PrescanCheck, Severity } from './types'

export interface PrescanOverrides {
  /** Check ids that must not run. */
  skip: Set<string>
  /** Check ids whose findings are forced to severity=warning. */
  warn: Set<string>
}

export function emptyOverrides(): PrescanOverrides {
  return { skip: new Set(), warn: new Set() }
}

/** Split repeatable CLI values and comma-separated lists into unique trimmed ids. */
export function normalizeCheckIds(values: string[] | string | undefined): string[] {
  if (values == null)
    return []
  const raw = Array.isArray(values) ? values : [values]
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    for (const part of entry.split(',')) {
      const id = part.trim()
      if (!id || seen.has(id))
        continue
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

export function parsePrescanOverrides(opts: {
  skip?: string[] | string
  warn?: string[] | string
}): PrescanOverrides {
  return {
    skip: new Set(normalizeCheckIds(opts.skip)),
    warn: new Set(normalizeCheckIds(opts.warn)),
  }
}

export function validateOverrideIds(
  overrides: PrescanOverrides,
  knownIds: Iterable<string>,
): void {
  const known = new Set(knownIds)
  const unknown = [...overrides.skip, ...overrides.warn].filter(id => !known.has(id))
  if (unknown.length === 0)
    return
  const sample = [...known].sort().slice(0, 8).join(', ')
  throw new Error(
    `Unknown prescan check id(s): ${unknown.join(', ')}. `
    + `Known ids include: ${sample}, … — see docs for the full list.`,
  )
}

export function filterChecksForOverrides(checks: PrescanCheck[], overrides: PrescanOverrides): {
  runnable: PrescanCheck[]
  skipped: string[]
} {
  if (overrides.skip.size === 0)
    return { runnable: checks, skipped: [] }
  const runnable: PrescanCheck[] = []
  const skipped: string[] = []
  for (const check of checks) {
    if (overrides.skip.has(check.id))
      skipped.push(check.id)
    else
      runnable.push(check)
  }
  return { runnable, skipped }
}

export function applyWarnOverrides(findings: Finding[], overrides: PrescanOverrides): Finding[] {
  if (overrides.warn.size === 0)
    return findings
  return findings.map((finding) => {
    if (!overrides.warn.has(finding.id) || finding.severity === 'warning' || finding.severity === 'info')
      return finding
    return { ...finding, severity: 'warning' as Severity }
  })
}

export function recountSeverities(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 }
  for (const finding of findings)
    counts[finding.severity]++
  return counts
}
