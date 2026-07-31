// src/build/prescan/capacitor-version.ts
import { join } from 'node:path'
import { readTextIfExists } from './gradle'

/**
 * Major version of the Capacitor runtime declared in package.json, or null.
 *
 * Checks `@capacitor/core` first (the platform-agnostic runtime), then the
 * platform packages `@capacitor/ios` and `@capacitor/android`, so both the iOS
 * and Android prescan checks resolve the same major from one shared place.
 * Reads dev+prod dependencies, returns null on a missing/malformed package.json
 * (never throws).
 */
export function capacitorMajor(projectDir: string): number | null {
  const raw = readTextIfExists(join(projectDir, 'package.json'))
  if (raw === null)
    return null
  let deps: Record<string, string>
  try {
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>, devDependencies?: Record<string, string> }
    deps = { ...pkg.devDependencies, ...pkg.dependencies }
  }
  catch {
    return null
  }
  const range = deps['@capacitor/core'] ?? deps['@capacitor/ios'] ?? deps['@capacitor/android']
  if (typeof range !== 'string')
    return null
  const m = range.match(/(\d+)/)
  return m ? Number(m[1]) : null
}
