import { isCancel as pIsCancel, log as pLog, select as pSelect, text as pText } from '@clack/prompts'
import { format, increment, parse } from '@std/semver'

/** CLI / API auto-bump levels (fix is normalized to patch at parse time) */
export type AutoBumpLevel = 'major' | 'minor' | 'patch' | 'metadata'

/** Resolver input including AI-backed classification */
export type AutoBumpInput = AutoBumpLevel | 'ai'

/** @std/semver increment release types used by auto-bump */
export type AutoBumpRelease = 'major' | 'minor' | 'patch' | 'prerelease'

const AUTO_BUMP_LEVELS = new Set<AutoBumpLevel>(['major', 'minor', 'patch', 'metadata'])

/**
 * Normalize CLI/SDK auto-bump values including `ai`.
 * - bare flag / true → minor
 * - fix → patch
 * - ai → ai (resolved later via Workers AI)
 * - metadata stays metadata (mapped to prerelease increment later)
 */
export function normalizeAutoBumpInput(
  level: string | boolean | undefined | null,
): AutoBumpInput | undefined {
  if (level === undefined || level === null || level === false)
    return undefined
  if (level === true)
    return 'minor'
  const normalized = String(level).trim().toLowerCase()
  if (normalized === 'fix')
    return 'patch'
  if (normalized === 'ai')
    return 'ai'
  if (AUTO_BUMP_LEVELS.has(normalized as AutoBumpLevel))
    return normalized as AutoBumpLevel
  return undefined
}

/**
 * Normalize CLI/SDK auto-bump values to concrete bump levels (excludes `ai`).
 * Prefer `normalizeAutoBumpInput` when `ai` is allowed.
 */
export function normalizeAutoBumpLevel(
  level: string | boolean | undefined | null,
): AutoBumpLevel | undefined {
  const input = normalizeAutoBumpInput(level)
  if (!input || input === 'ai')
    return undefined
  return input
}

export function autoBumpLevelToRelease(level: AutoBumpLevel | AutoBumpRelease): AutoBumpRelease {
  if (level === 'metadata' || level === 'prerelease')
    return 'prerelease'
  return level
}

function fallbackBump(currentVersion: string, release: AutoBumpRelease): string {
  const match = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)(.*)?$/)
  if (!match) {
    if (release === 'major')
      return '1.0.0'
    if (release === 'minor')
      return '0.1.0'
    if (release === 'prerelease')
      return '1.0.1-0'
    return '1.0.1'
  }

  const major = Number.parseInt(match[1], 10)
  const minor = Number.parseInt(match[2], 10)
  const patch = Number.parseInt(match[3], 10)
  const rest = match[4] ?? ''

  if (release === 'major')
    return `${major + 1}.0.0`
  if (release === 'minor')
    return `${major}.${minor + 1}.0`
  if (release === 'patch')
    return `${major}.${minor}.${patch + 1}`

  // prerelease / metadata
  const preMatch = rest.match(/^-([A-Za-z0-9.-]*?)(\d+)?$/)
  if (preMatch) {
    const id = preMatch[1] ?? ''
    const num = preMatch[2] !== undefined ? Number.parseInt(preMatch[2], 10) + 1 : 0
    if (id.endsWith('.') || id === '')
      return `${major}.${minor}.${patch}-${id}${num}`
    return `${major}.${minor}.${patch}-${id}${id ? '.' : ''}${num}`
  }
  // No prerelease yet: match @std/semver prerelease (acts like prepatch → x.y.(z+1)-0)
  return `${major}.${minor}.${patch + 1}-0`
}

/**
 * Auto-bump a semver version by the given level
 * @param currentVersion - The current version string (e.g., "1.0.0")
 * @param level - major | minor | patch | metadata | prerelease
 * @returns The bumped version or a fallback version if parsing fails
 */
export function autoBumpVersionBy(
  currentVersion: string,
  level: AutoBumpLevel | AutoBumpRelease = 'minor',
): string {
  const release = autoBumpLevelToRelease(level)
  try {
    const parsed = parse(currentVersion)
    return format(increment(parsed, release))
  }
  catch {
    return fallbackBump(currentVersion, release)
  }
}

/**
 * Auto-bump a semver version by incrementing the patch number
 * @param currentVersion - The current version string (e.g., "1.0.0")
 * @returns The bumped version or a fallback version if parsing fails
 */
export function autoBumpVersion(currentVersion: string): string {
  return autoBumpVersionBy(currentVersion, 'patch')
}

/**
 * Auto-bump a semver version by incrementing the minor number
 * @param currentVersion - The current version string (e.g., "1.0.0")
 * @returns The bumped version or a fallback version if parsing fails
 */
export function autoBumpMinorVersion(currentVersion: string): string {
  return autoBumpVersionBy(currentVersion, 'minor')
}

/**
 * Interactively ask the user how to handle version bumping
 * @param currentVersion - The current version
 * @param context - Optional context string (e.g., "upload", "onboarding")
 * @returns The new version string or null if cancelled
 */
export async function interactiveVersionBump(
  currentVersion: string,
  context?: string,
): Promise<string | null> {
  const nextVersion = autoBumpVersion(currentVersion)
  const contextMsg = context ? ` for ${context}` : ''

  const versionChoice = await pSelect({
    message: `How do you want to handle the version${contextMsg}?`,
    options: [
      { value: 'auto', label: `Auto: Bump patch version (${currentVersion} → ${nextVersion})` },
      { value: 'manual', label: 'Manual: I\'ll provide the version number' },
    ],
  })

  if (pIsCancel(versionChoice)) {
    return null
  }

  if (versionChoice === 'auto') {
    pLog.info(`🔢 Auto-bumped version from ${currentVersion} to ${nextVersion}`)
    return nextVersion
  }

  // Manual version input
  const userVersion = await pText({
    message: `Current version is ${currentVersion}. Enter new version:`,
    validate: (value: string | undefined) => {
      if (!value)
        return 'Version is required'
      if (!/^\d+\.\d+\.\d+/.test(value))
        return 'Please enter a valid version (x.y.z)'
    },
  })

  if (pIsCancel(userVersion)) {
    return null
  }

  return userVersion as string
}

/**
 * Get suggestions for alternative versions when a version already exists
 * @param existingVersion - The version that already exists
 * @returns Array of suggested alternative versions
 */
export function getVersionSuggestions(existingVersion: string): string[] {
  const bumped = autoBumpVersion(existingVersion)

  // Try to parse and increment different parts
  try {
    const parsed = parse(existingVersion)
    return [
      bumped, // Patch bump
      format(increment(parsed, 'minor')), // Minor bump
      `${existingVersion}-beta.1`, // Beta version
      `${existingVersion}.1`, // Subpatch
    ]
  }
  catch {
    // Fallback suggestions
    return [
      bumped,
      `${existingVersion}.1`,
      `${existingVersion}-beta.1`,
      `${existingVersion}-rc.1`,
    ]
  }
}
