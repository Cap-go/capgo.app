/** npm package name used for Capgo CLI version matching. */
export const CAPGO_CLI_PACKAGE = '@capgo/cli'

/** Capacitor runtime package (often omitted from bundle native_packages). */
export const CAPACITOR_CORE_PACKAGE = '@capacitor/core'

export function normalizePackageName(name: string): string {
  return name.trim().toLowerCase()
}

export function isInScopeAppPackage(name: string): boolean {
  const n = normalizePackageName(name)
  if (n === normalizePackageName(CAPGO_CLI_PACKAGE))
    return true
  if (n === normalizePackageName('@capgo/camera-preview'))
    return true
  if (n.startsWith('@capgo/capacitor-'))
    return true
  if (n.startsWith('@capacitor/'))
    return true
  if (n === 'capacitor-plus' || n.startsWith('capacitor-plus'))
    return true
  if (n.startsWith('capacitor-') && !n.startsWith('capacitor-plus'))
    return true
  return false
}

export function filterInScopePackages(packages: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>()
  for (const [name, version] of packages) {
    if (isInScopeAppPackage(name))
      out.set(normalizePackageName(name), version)
  }
  return out
}
