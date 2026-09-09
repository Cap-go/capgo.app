import { lessThan, parse } from '@std/semver'

export const UPDATER_PACKAGE_NAME = '@capgo/capacitor-updater'
export const MIN_SUPPORTED_PLUGIN_MAJOR = 5
export const UPDATER_INSTALL_DOCS_URL = 'https://capgo.app/docs/plugins/updater/getting-started/'

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@capgo%2fcapacitor-updater'
const DIST_TAG_CACHE_MS = 60 * 60 * 1000

export interface PluginVersionRow {
  plugin_version: string
  devices: number
  total_devices: number
}

export interface PluginDistTags {
  latest?: string
  [tag: string]: string | undefined
}

export type PluginVersionStatus = 'current' | 'behind' | 'unsupported' | 'unknown'

export interface PluginMajorStats {
  major: number
  devices: number
  share: number
  latestVersion: string | null
  npmTag: string | null
  installPackage: string | null
  behindDevices: number
  currentDevices: number
  unsupported: boolean
  statusResolved: boolean
}

export interface PluginVersionRecommendationRow extends PluginVersionRow {
  major: number | null
  latestForMajor: string | null
  status: PluginVersionStatus
}

export interface PluginVersionRecommendation {
  dominantVersion: string
  dominantMajor: number | null
  recommendedVersion: string | null
  recommendedTag: string | null
  installPackage: string | null
  installCommand: string | null
  needsUpdate: boolean
  unsupported: boolean
  behindDevices: number
  behindShare: number
  currentDevices: number
  fleetDevices: number
  statusResolved: boolean
  majors: PluginMajorStats[]
  rows: PluginVersionRecommendationRow[]
}

interface NpmRegistryResponse {
  'dist-tags'?: PluginDistTags
}

let distTagCache: { tags: PluginDistTags, fetchedAt: number } | null = null
let distTagInFlight: Promise<PluginDistTags | null> | null = null

export function parsePluginVersion(version: string) {
  try {
    return parse(version)
  }
  catch {
    return null
  }
}

export function pluginMajorFromVersion(version: string): number | null {
  return parsePluginVersion(version)?.major ?? null
}

export function isUnsupportedPluginMajor(major: number | null): boolean {
  return major === null || major < MIN_SUPPORTED_PLUGIN_MAJOR
}

export function latestTagForMajor(major: number, distTags: PluginDistTags | null): { tag: string, version: string } | null {
  if (!distTags)
    return null

  const latest = distTags.latest
  const latestMajor = latest ? pluginMajorFromVersion(latest) : null
  if (latest && latestMajor === major)
    return { tag: 'latest', version: latest }

  const ltsTag = `lts-v${major}`
  const ltsVersion = distTags[ltsTag]
  if (ltsVersion)
    return { tag: ltsTag, version: ltsVersion }

  return null
}

export function installPackageForTag(tag: string) {
  return `${UPDATER_PACKAGE_NAME}@${tag}`
}

export function installCommandForPackage(installPackage: string) {
  return `npm install ${installPackage}`
}

export function isPluginVersionBehind(version: string, latestVersion: string): boolean {
  const current = parsePluginVersion(version)
  const latest = parsePluginVersion(latestVersion)
  if (!current || !latest)
    return false
  return lessThan(current, latest)
}

function rowStatus(
  version: string,
  major: number | null,
  latestVersion: string | null,
): PluginVersionStatus {
  if (major === null)
    return 'unknown'
  if (isUnsupportedPluginMajor(major))
    return 'unsupported'
  if (!latestVersion)
    return 'unknown'
  return isPluginVersionBehind(version, latestVersion) ? 'behind' : 'current'
}

export function buildPluginVersionRecommendation(
  versions: PluginVersionRow[],
  distTags: PluginDistTags | null,
): PluginVersionRecommendation | null {
  if (versions.length === 0)
    return null

  const fleetDevices = versions[0]?.total_devices ?? versions.reduce((sum, row) => sum + row.devices, 0)
  const tagsKnown = distTags !== null
  const dominant = versions[0]
  const dominantMajor = pluginMajorFromVersion(dominant.plugin_version)
  const dominantLatest = dominantMajor === null ? null : latestTagForMajor(dominantMajor, distTags)
  const unsupported = tagsKnown && isUnsupportedPluginMajor(dominantMajor) && dominantMajor !== null
  const needsUpdate = unsupported || (
    !!dominantLatest && isPluginVersionBehind(dominant.plugin_version, dominantLatest.version)
  )

  const majorBuckets = new Map<number, PluginVersionRow[]>()
  const rows: PluginVersionRecommendationRow[] = versions.map((row) => {
    const major = pluginMajorFromVersion(row.plugin_version)
    if (major !== null) {
      const bucket = majorBuckets.get(major) ?? []
      bucket.push(row)
      majorBuckets.set(major, bucket)
    }
    const latest = major === null ? null : latestTagForMajor(major, distTags)
    return {
      ...row,
      major,
      latestForMajor: latest?.version ?? null,
      status: rowStatus(row.plugin_version, major, latest?.version ?? null),
    }
  })

  const majors: PluginMajorStats[] = [...majorBuckets.entries()]
    .sort((a, b) => b[1].reduce((sum, row) => sum + row.devices, 0) - a[1].reduce((sum, row) => sum + row.devices, 0) || b[0] - a[0])
    .map(([major, bucket]) => {
      const devices = bucket.reduce((sum, row) => sum + row.devices, 0)
      const latest = latestTagForMajor(major, distTags)
      const unsupportedMajor = isUnsupportedPluginMajor(major)
      const statusResolved = tagsKnown && (unsupportedMajor || latest !== null)
      const behindDevices = statusResolved
        ? bucket.reduce((sum, row) => {
            if (unsupportedMajor || (latest && isPluginVersionBehind(row.plugin_version, latest.version)))
              return sum + row.devices
            return sum
          }, 0)
        : 0
      const currentDevices = statusResolved && latest
        ? bucket.reduce((sum, row) => {
            if (isPluginVersionBehind(row.plugin_version, latest.version))
              return sum
            return sum + row.devices
          }, 0)
        : 0
      return {
        major,
        devices,
        share: fleetDevices > 0 ? (devices / fleetDevices) * 100 : 0,
        latestVersion: latest?.version ?? null,
        npmTag: latest?.tag ?? null,
        installPackage: latest ? installPackageForTag(latest.tag) : null,
        behindDevices,
        currentDevices,
        unsupported: unsupportedMajor,
        statusResolved,
      }
    })

  const behindDevices = majors.reduce((sum, major) => sum + major.behindDevices, 0)
  const currentDevices = majors.reduce((sum, major) => sum + major.currentDevices, 0)
  const statusResolved = tagsKnown && rows.every(row => row.status !== 'unknown')
  const installPackage = dominantLatest && !unsupported
    ? installPackageForTag(dominantLatest.tag)
    : null

  return {
    dominantVersion: dominant.plugin_version,
    dominantMajor,
    recommendedVersion: dominantLatest?.version ?? null,
    recommendedTag: dominantLatest?.tag ?? null,
    installPackage,
    installCommand: installPackage ? installCommandForPackage(installPackage) : null,
    needsUpdate,
    unsupported,
    behindDevices,
    behindShare: fleetDevices > 0 ? (behindDevices / fleetDevices) * 100 : 0,
    currentDevices,
    fleetDevices,
    statusResolved,
    majors,
    rows,
  }
}

export async function fetchUpdaterDistTags(): Promise<PluginDistTags | null> {
  const now = Date.now()
  if (distTagCache && now - distTagCache.fetchedAt < DIST_TAG_CACHE_MS)
    return distTagCache.tags
  if (distTagInFlight)
    return distTagInFlight

  distTagInFlight = (async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const signal = typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(10_000)
      : (() => {
          const controller = new AbortController()
          timeout = setTimeout(() => controller.abort(), 10_000)
          return controller.signal
        })()
    try {
      const response = await fetch(NPM_REGISTRY_URL, {
        headers: {
          accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*',
        },
        signal,
      })
      if (!response.ok)
        return null
      const data = await response.json() as NpmRegistryResponse
      const tags = data['dist-tags']
      if (!tags)
        return null
      distTagCache = { tags, fetchedAt: Date.now() }
      return tags
    }
    catch {
      return null
    }
    finally {
      if (timeout)
        clearTimeout(timeout)
      distTagInFlight = null
    }
  })()

  return distTagInFlight
}

export function resetUpdaterDistTagCache() {
  distTagCache = null
  distTagInFlight = null
}
