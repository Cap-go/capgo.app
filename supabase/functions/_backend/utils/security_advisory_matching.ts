import type {
  Advisory,
  AdvisoryAffected,
  AdvisoryMatchStatus,
  AppAdvisoryMatch,
} from '../../shared/security_advisory.ts'
import { canParse, greaterOrEqual, parse } from '@std/semver'
import { normalizePackageName } from './security_advisory_packages.ts'
import { normalizeVersionString, satisfiesGhsaAffectedRange } from './security_advisory_version.ts'

export function resolveAdvisoryStatus(
  currentVersion: string,
  affected: Pick<AdvisoryAffected, 'affected_range' | 'patched_version'>,
): AdvisoryMatchStatus {
  const normalized = normalizeVersionString(currentVersion)
  if (!normalized || !canParse(normalized))
    return 'unknown'
  try {
    const version = parse(normalized)
    if (!satisfiesGhsaAffectedRange(version, affected.affected_range))
      return 'patched'
    if (affected.patched_version === null)
      return 'affected'
    const patched = normalizeVersionString(affected.patched_version)
    if (!patched || !canParse(patched))
      return 'unknown'
    if (greaterOrEqual(version, parse(patched)))
      return 'patched'
    return 'affected'
  }
  catch {
    return 'unknown'
  }
}

export function matchAppPackagesToAdvisories(
  packages: ReadonlyMap<string, string>,
  advisories: readonly Advisory[],
): AppAdvisoryMatch[] {
  const items: AppAdvisoryMatch[] = []
  for (const advisory of advisories) {
    for (const affected of advisory.affected) {
      const pkgKey = normalizePackageName(affected.package)
      const currentVersion = packages.get(pkgKey)
      if (currentVersion === undefined)
        continue
      items.push({
        package: affected.package,
        current_version: currentVersion,
        advisory,
        affected,
        status: resolveAdvisoryStatus(currentVersion, affected),
      })
    }
  }
  items.sort((a, b) => {
    const byPackage = a.package.localeCompare(b.package)
    if (byPackage !== 0)
      return byPackage
    return a.advisory.id.localeCompare(b.advisory.id)
  })
  return items
}
