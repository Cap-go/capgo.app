import type { PbxTarget } from './pbxproj-parser'
import { parseMobileprovisionDetailedFromBase64 } from './mobileprovision-parser'

export type ProvisioningMapErrorCode = 'missing' | 'empty' | 'malformed' | 'invalid'

export class ProvisioningMapError extends Error {
  constructor(public readonly code: ProvisioningMapErrorCode, message: string) {
    super(message)
    this.name = 'ProvisioningMapError'
  }
}

export interface ProvisioningMapEntry {
  profile: string
  name: string
  readonly bundleId: string
}

export type ProvisioningMap = Record<string, ProvisioningMapEntry>

export interface ProvisioningTargetGroup {
  bundleId: string
  targetNames: string[]
}

export interface WildcardReuse {
  entry: ProvisioningMapEntry
  sourceKeys: string[]
  targets: ProvisioningTargetGroup[]
}

export interface ProvisioningCoverage {
  exact: ProvisioningTargetGroup[]
  missing: ProvisioningTargetGroup[]
  unresolved: PbxTarget[]
  wildcardReuse: WildcardReuse | null
  wildcardConflict: ProvisioningTargetGroup[]
  generation: ProvisioningTargetGroup[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function invalidMap(message: string): never {
  throw new ProvisioningMapError('invalid', message)
}

/** Cache the parsed bundle ID without changing the persisted { profile, name } contract. */
export function createProvisioningMapEntry(profile: string, name: string, bundleId: string): ProvisioningMapEntry {
  const entry = { profile, name } as ProvisioningMapEntry
  Object.defineProperty(entry, 'bundleId', { value: bundleId })
  return entry
}

export function parseProvisioningMap(raw: unknown): ProvisioningMap {
  if (raw === undefined || raw === null)
    throw new ProvisioningMapError('missing', 'No provisioning profile map is saved')
  if (typeof raw !== 'string' || raw.trim() === '')
    invalidMap('The saved provisioning profile map is empty or invalid')

  let value: unknown
  try {
    value = JSON.parse(raw)
  }
  catch {
    throw new ProvisioningMapError('malformed', 'The saved provisioning profile map is not valid JSON')
  }

  const entries = record(value)
  if (!entries)
    invalidMap('The saved provisioning profile map must be a JSON object')
  if (Object.keys(entries).length === 0)
    throw new ProvisioningMapError('empty', 'The saved provisioning profile map has no profiles')

  const map = Object.create(null) as ProvisioningMap
  for (const [bundleId, stored] of Object.entries(entries)) {
    if (!bundleId.trim())
      invalidMap('The saved provisioning profile map contains an empty bundle ID')
    const storedRecord = record(stored)
    const profile = typeof stored === 'string'
      ? stored
      : storedRecord && Object.hasOwn(storedRecord, 'profile') && typeof storedRecord.profile === 'string'
        ? storedRecord.profile
        : undefined
    if (!profile)
      invalidMap(`The saved provisioning profile for ${bundleId} is invalid`)

    try {
      const detail = parseMobileprovisionDetailedFromBase64(profile)
      map[bundleId] = createProvisioningMapEntry(profile, detail.name, detail.bundleId)
    }
    catch {
      invalidMap(`The saved provisioning profile for ${bundleId} is invalid`)
    }
  }
  return map
}

export function isConcreteBundleId(bundleId: string): boolean {
  const value = bundleId.trim()
  return value.length > 0
    && !value.includes('*')
    && !value.includes('$(')
    && !value.includes('${')
}

export function wildcardBundleMatches(wildcardBundleId: string, targetBundleId: string): boolean {
  if (wildcardBundleId === '*')
    return true
  if (!wildcardBundleId.endsWith('.*'))
    return false
  const prefix = wildcardBundleId.slice(0, -2)
  return prefix.length > 0 && targetBundleId.startsWith(`${prefix}.`) && targetBundleId.length > prefix.length + 1
}

function groupTargets(targets: PbxTarget[]): ProvisioningTargetGroup[] {
  const groups = new Map<string, ProvisioningTargetGroup>()
  for (const target of targets) {
    const existing = groups.get(target.bundleId)
    if (existing)
      existing.targetNames.push(target.name)
    else
      groups.set(target.bundleId, { bundleId: target.bundleId, targetNames: [target.name] })
  }
  return [...groups.values()]
}

export function analyzeProvisioningCoverage(targets: PbxTarget[], map: ProvisioningMap): ProvisioningCoverage {
  const unresolved = targets.filter(target => !isConcreteBundleId(target.bundleId))
  const groups = groupTargets(targets.filter(target => isConcreteBundleId(target.bundleId)))
  const exact = groups.filter(target => Object.hasOwn(map, target.bundleId))
  const missing = groups.filter(target => !Object.hasOwn(map, target.bundleId))

  const matchingWildcards = new Map<string, {
    entry: ProvisioningMapEntry
    sourceKeys: string[]
    targetBundleIds: Set<string>
  }>()

  for (const [sourceKey, entry] of Object.entries(map)) {
    const matchingTargets = missing.filter(target => wildcardBundleMatches(entry.bundleId, target.bundleId))
    if (matchingTargets.length === 0)
      continue
    const existing = matchingWildcards.get(entry.profile)
    if (existing) {
      existing.sourceKeys.push(sourceKey)
      for (const target of matchingTargets)
        existing.targetBundleIds.add(target.bundleId)
    }
    else {
      matchingWildcards.set(entry.profile, {
        entry,
        sourceKeys: [sourceKey],
        targetBundleIds: new Set(matchingTargets.map(target => target.bundleId)),
      })
    }
  }

  const wildcardCandidates = [...matchingWildcards.values()]
  const matchedBundleIds = new Set(wildcardCandidates.flatMap(candidate => [...candidate.targetBundleIds]))
  const wildcardConflict = wildcardCandidates.length > 1
    ? missing.filter(target => matchedBundleIds.has(target.bundleId))
    : []
  const candidate = wildcardCandidates.length === 1 ? wildcardCandidates[0]! : undefined
  const wildcardReuse = candidate
    ? {
        entry: candidate.entry,
        sourceKeys: candidate.sourceKeys,
        targets: missing.filter(target => candidate.targetBundleIds.has(target.bundleId)),
      }
    : null

  return {
    exact,
    missing,
    unresolved,
    wildcardReuse,
    wildcardConflict,
    generation: missing.filter(target => !matchedBundleIds.has(target.bundleId)),
  }
}
