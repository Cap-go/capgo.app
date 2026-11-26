import { parse } from '@std/semver'

/**
 * What to do when the "Minimal update version" field is committed (blur or Enter).
 * - `noop`: value unchanged, no write.
 * - `empty`: the field was cleared. Never written: an empty min_update_version blocks
 *   pushes for channels on `version_number`, so the field reverts to the stored value.
 * - `invalid`: not a semver, revert and show the invalid version error.
 * - `save`: write the trimmed value.
 */
type MinUpdateVersionCommit
  = | { kind: 'noop' }
    | { kind: 'empty' }
    | { kind: 'invalid' }
    | { kind: 'save', value: string }

function isSemver(value: string) {
  try {
    return !!parse(value)
  }
  catch {
    return false
  }
}

export function resolveMinUpdateVersionCommit(input: string | null | undefined, stored: string | null | undefined): MinUpdateVersionCommit {
  const value = (input ?? '').trim()
  const current = (stored ?? '').trim()
  if (value === current)
    return { kind: 'noop' }
  if (value.length === 0)
    return { kind: 'empty' }
  if (!isSemver(value))
    return { kind: 'invalid' }
  return { kind: 'save', value }
}
