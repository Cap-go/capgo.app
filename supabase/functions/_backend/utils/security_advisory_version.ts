import type { SemVer } from '@std/semver'
import { parseRange, satisfies } from '@std/semver'

/** Strip a leading v and trim; returns null when empty. */
export function normalizeVersionString(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed)
    return null
  return trimmed.replace(/^v/i, '')
}

/**
 * GHSA ranges use comma-separated AND clauses per interval, with `||` between intervals.
 * Example: `>= 7.0.0, < 7.2.1 || >= 6.0.0, < 6.2.0`
 */
export function satisfiesGhsaAffectedRange(version: SemVer, affectedRange: string): boolean {
  const intervals = affectedRange.split('||').map(part => part.trim()).filter(Boolean)
  if (intervals.length === 0)
    throw new Error('Empty advisory affected range')
  return intervals.some((interval) => {
    const clauses = interval.split(',').map(part => part.trim()).filter(Boolean)
    if (clauses.length === 0)
      return false
    return clauses.every(clause => satisfies(version, parseRange(clause)))
  })
}
