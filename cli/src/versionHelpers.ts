import { isCancel as pIsCancel, log as pLog, select as pSelect, text as pText } from '@clack/prompts'
import { format, increment, parse } from '@std/semver'

/**
 * Auto-bump a semver version by incrementing the patch number
 * @param currentVersion - The current version string (e.g., "1.0.0")
 * @returns The bumped version or a fallback version if parsing fails
 */
export function autoBumpVersion(currentVersion: string): string {
  try {
    const parsed = parse(currentVersion)
    return format(increment(parsed, 'patch'))
  }
  catch {
    // Fallback: try to extract major.minor and increment patch
    const match = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)/)
    if (match) {
      const [, major, minor, patch] = match
      return `${major}.${minor}.${Number.parseInt(patch) + 1}`
    }
    return '1.0.1' // Ultimate fallback
  }
}

/**
 * Auto-bump a semver version by incrementing the minor number
 * @param currentVersion - The current version string (e.g., "1.0.0")
 * @returns The bumped version or a fallback version if parsing fails
 */
export function autoBumpMinorVersion(currentVersion: string): string {
  try {
    const parsed = parse(currentVersion)
    return format(increment(parsed, 'minor'))
  }
  catch {
    // Fallback: try to extract major.minor and increment minor
    const match = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)/)
    if (match) {
      const [, major, minor] = match
      return `${major}.${Number.parseInt(minor) + 1}.0`
    }
    return '0.1.0' // Ultimate fallback
  }
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
