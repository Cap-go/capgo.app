import type { SemVer } from '@std/semver'
import { parseRange, satisfies } from '@std/semver'

/** Strip a leading v and trim; returns null when empty. */
export function normalizeVersionString(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed)
    return null
  return trimmed.replace(/^v/i, '')
}

/** GHSA ranges use comma-separated AND clauses (e.g. ">= 6.0.0, < 6.14.3"). */
export function satisfiesGhsaAffectedRange(version: SemVer, affectedRange: string): boolean {
  const clauses = affectedRange.split(',').map(part => part.trim()).filter(Boolean)
  if (clauses.length === 0)
    return false
  return clauses.every(clause => satisfies(version, parseRange(clause)))
}
