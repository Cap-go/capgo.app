import subset from 'semver/ranges/subset'
import { useConsole } from '~/services/console'

// Kept apart from console.ts so `semver` only loads with the bundle and channel pages.
export function convertNativePackages(nativePackages: { name: string, version: string }[] | null | undefined) {
  // Missing metadata is normal for older bundles / empty channels — treat as empty.
  if (!nativePackages)
    return new Map<string, { name: string, version: string }>()

  // Check types
  nativePackages.forEach((data) => {
    if (typeof data !== 'object') {
      throw new TypeError(`Invalid remote native package data: ${data}, expected object, got ${typeof data}`)
    }

    const { name, version } = data
    if (!name || typeof name !== 'string') {
      throw new Error(`Invalid remote native package name: ${name}, expected string, got ${typeof name}`)
    }

    if (!version || typeof version !== 'string') {
      throw new TypeError(`Invalid remote native package version: ${version}, expected string, got ${typeof version}`)
    }
  })

  const mappedRemoteNativePackages = new Map((nativePackages)
    .map(a => [a.name, a]))

  return mappedRemoteNativePackages
}

export async function getRemoteDependencies(appId: string, channel: string) {
  const { data: remoteNativePackages, error } = await useConsole()
    .from('channels')
    .select(`version:app_versions!channels_version_fkey(
            native_packages
        )`)
    .eq('name', channel)
    .eq('app_id', appId)
    .single()

  if (error) {
    throw new Error(error.message)
  }
  const version = remoteNativePackages.version as { native_packages?: unknown } | null
  // Channel may have no linked version, or an older version without metadata.
  // Match CLI: fall back to [] so linking still works.
  const nativePackages = Array.isArray(version?.native_packages)
    ? version.native_packages
    : []
  return convertNativePackages(nativePackages as { name: string, version: string }[])
}

interface Compatibility {
  name: string
  localVersion: string | undefined
  remoteVersion: string | undefined
}

export function isCompatible(pkg: Compatibility): boolean {
  // Only check compatibility if there's a local version
  // If there's a local version but no remote version, or versions don't match, it's incompatible
  if (!pkg.localVersion)
    return true // If no local version, it's compatible (remote-only package)
  if (!pkg.remoteVersion)
    return false // If local version but no remote version, it's incompatible
  try {
    return subset(pkg.localVersion, pkg.remoteVersion)
  }
  catch {
    return false // If version comparison fails, consider it incompatible
  }
}

export async function checkCompatibilityNativePackages(appId: string, channel: string, nativePackages: { name: string, version: string }[]) {
  const mappedRemoteNativePackages = await getRemoteDependencies(appId, channel)

  // Nothing on the channel to compare against → skip gate (same as missing local metadata).
  if (mappedRemoteNativePackages.size === 0) {
    return {
      finalCompatibility: [] as Compatibility[],
      localDependencies: nativePackages,
    }
  }

  const finalDependencies: Compatibility[] = nativePackages
    .map((local) => {
      const remotePackage = mappedRemoteNativePackages.get(local.name)
      if (remotePackage) {
        return {
          name: local.name,
          localVersion: local.version,
          remoteVersion: remotePackage.version,
        }
      }

      return {
        name: local.name,
        localVersion: local.version,
        remoteVersion: undefined,
      }
    })

  // Only include remote packages that are not in local for informational purposes
  // These won't affect compatibility
  const removeNotInLocal = [...mappedRemoteNativePackages]
    .filter(([remoteName]) => !nativePackages.some(a => a.name === remoteName))
    .map(([name, version]) => ({ name, localVersion: undefined, remoteVersion: version.version }))

  finalDependencies.push(...removeNotInLocal)

  return {
    finalCompatibility: finalDependencies,
    localDependencies: nativePackages,
  }
}
