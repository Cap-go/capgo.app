import type { Context } from 'hono'
import type { NativePackage } from './bundle_compatibility.ts'
import { CAPACITOR_CORE_PACKAGE, CAPGO_CLI_PACKAGE, filterInScopePackages, normalizePackageName } from './security_advisory_packages.ts'
import { closeClient, getPgClient } from './pg.ts'
import { queryJson, queryJsonOne } from './pg_rls.ts'

interface ReportedVersionsRow {
  native_packages: unknown
  cli_version: string | null
}

/** Build a package-to-version map from stored bundle metadata (blank versions become empty strings). */
export function toNativePackageMap(packages: NativePackage[] | null | undefined): Map<string, string> {
  const map = new Map<string, string>()
  if (!packages?.length)
    return map
  for (const pkg of packages) {
    if (typeof pkg?.name !== 'string')
      continue
    const name = normalizePackageName(pkg.name)
    if (!name)
      continue
    const version = typeof pkg.version === 'string' ? pkg.version.trim() : ''
    const existing = map.get(name)
    if (existing !== undefined && existing !== '' && version === '')
      continue
    map.set(name, version)
  }
  return map
}

/** Surface core advisories as unknown when platform packages are reported without core (no version guess). */
export function ensureCapacitorCorePlaceholder(map: Map<string, string>): void {
  const coreKey = normalizePackageName(CAPACITOR_CORE_PACKAGE)
  if (map.has(coreKey))
    return
  const iosKey = normalizePackageName('@capacitor/ios')
  const androidKey = normalizePackageName('@capacitor/android')
  if (map.has(iosKey) || map.has(androidKey))
    map.set(coreKey, '')
}

function withCliVersion(map: Map<string, string>, cliVersion: string | null | undefined): Map<string, string> {
  const cliKey = normalizePackageName(CAPGO_CLI_PACKAGE)
  const trimmed = typeof cliVersion === 'string' ? cliVersion.trim() : ''
  map.set(cliKey, trimmed)
  return map
}

async function loadProductionChannelReported(c: Context, appId: string): Promise<ReportedVersionsRow | null> {
  const pg = await getPgClient(c)
  try {
    return await queryJsonOne<ReportedVersionsRow>(
      pg,
      `SELECT av.native_packages, av.cli_version
       FROM public.channels ch
       INNER JOIN public.app_versions av ON av.id = ch.version
       WHERE ch.app_id = $1
         AND ch.name = 'production'
         AND ch.version IS NOT NULL
         AND COALESCE(av.deleted, false) = false
       LIMIT 1`,
      [appId],
    )
  }
  finally {
    closeClient(c, pg)
  }
}

async function loadLatestUploadReported(c: Context, appId: string): Promise<ReportedVersionsRow | null> {
  const pg = await getPgClient(c)
  try {
    const rows = await queryJson<ReportedVersionsRow>(
      pg,
      `SELECT av.native_packages, av.cli_version
       FROM public.app_versions av
       WHERE av.app_id = $1
         AND COALESCE(av.deleted, false) = false
       ORDER BY av.id DESC
       LIMIT 1`,
      [appId],
    )
    return rows[0] ?? null
  }
  finally {
    closeClient(c, pg)
  }
}

/** Native and CLI versions already reported on bundles for this app (no new SDK fields). */
export async function loadAppReportedPackages(c: Context, appId: string): Promise<Map<string, string>> {
  const production = await loadProductionChannelReported(c, appId)
  const latest = await loadLatestUploadReported(c, appId)
  const nativeRow = production ?? latest
  const map = filterInScopePackages(
    toNativePackageMap(nativeRow?.native_packages as NativePackage[] | null | undefined),
  )
  const cliVersion = latest?.cli_version ?? nativeRow?.cli_version
  withCliVersion(map, cliVersion)
  ensureCapacitorCorePlaceholder(map)
  const cliKey = normalizePackageName(CAPGO_CLI_PACKAGE)
  if (!map.has(cliKey))
    map.set(cliKey, '')
  return map
}
