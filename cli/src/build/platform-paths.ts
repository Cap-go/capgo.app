/**
 * Platform Path Helpers
 *
 * Used by cloud build packaging to resolve custom Capacitor native project paths
 * (e.g. android.path / ios.path) in monorepos.
 */

/**
 * Normalize a user-configured relative path:
 * - Converts Windows separators to forward slashes
 * - Strips a leading "./"
 * - Strips trailing slashes
 * - Returns "" for "." / "./" / empty
 */
export function normalizeRelPath(input: string): string {
  let s = `${input ?? ''}`.trim()
  if (!s)
    return ''

  // Convert Windows separators to POSIX separators (zip paths are always "/")
  if (s.includes('\\'))
    s = s.split('\\').join('/')

  // Collapse accidental duplicate separators (can happen with escaped paths)
  while (s.includes('//'))
    s = s.replace('//', '/')

  // Strip leading "./" (repeatable)
  while (s.startsWith('./'))
    s = s.slice(2)

  // Strip trailing "/" (repeatable)
  while (s.endsWith('/'))
    s = s.slice(0, -1)

  if (s === '.')
    return ''

  return s
}

/**
 * Get the platform directory to use inside the project zip based on Capacitor config.
 * Falls back to the default platform directory ("ios" or "android") when not configured
 * or when configured as ".".
 */
export function getPlatformDirFromCapacitorConfig(capConfig: any, platform: 'ios' | 'android'): string {
  const configured = capConfig?.[platform]?.path
  if (typeof configured === 'string' && configured.trim()) {
    const normalized = normalizeRelPath(configured)
    if (normalized)
      return normalized
  }
  return platform
}

/**
 * Normalize Windows path separators inside native dependency path literals.
 * Capacitor CLI on Windows writes backslashes into SPM Package.swift, CocoaPods
 * Podfiles, and Gradle settings — Swift treats `\` as escape sequences and SPM
 * resolution fails on macOS builders.
 */
export function normalizeNativeDependencyPathsInText(content: string): string {
  const normalizePathBody = (pathBody: string) => pathBody.replace(/\\/g, '/')

  return content
    .replace(/(path:\s*["'])((?:[^"'\\]|\\.)*)(["'])/g, (_match, open: string, pathBody: string, close: string) =>
      `${open}${normalizePathBody(pathBody)}${close}`)
    .replace(/(:path\s*=>\s*["'])((?:[^"'\\]|\\.)*)(["'])/g, (_match, open: string, pathBody: string, close: string) =>
      `${open}${normalizePathBody(pathBody)}${close}`)
    .replace(/(new\s+File\s*\(\s*["'])((?:[^"'\\]|\\.)*)(["']\s*\))/g, (_match, open: string, pathBody: string, close: string) =>
      `${open}${normalizePathBody(pathBody)}${close}`)
}
